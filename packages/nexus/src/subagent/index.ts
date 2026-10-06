import { Effect, Context, Schema, Layer, Schedule } from "effect"
import { LayerNode } from "@nexus-ai/core/effect/layer-node"
import { randomUUID } from "crypto"
import { spawn as spawnProcess, type ChildProcess } from "node:child_process"
import { join } from "node:path"

export interface SubagentConfig {
  id: string
  name: string
  workingDirectory: string
  objective: string
  model?: string
  maxTurns?: number
  allowedTools?: string[]
  environment?: Record<string, string>
}

export interface SubagentResult {
  id: string
  success: boolean
  output?: string
  error?: string
  turns: number
  durationMs: number
}

export interface SubagentStatus {
  id: string
  name: string
  state: "pending" | "running" | "completed" | "failed" | "cancelled"
  objective: string
  workingDirectory: string
  startedAt?: number
  completedAt?: number
  result?: SubagentResult
}

export class SubagentError extends Schema.TaggedErrorClass<SubagentError>()("SubagentError", {
  message: Schema.String,
  subagentId: Schema.String,
}) {}

export class SubagentNotFoundError extends Schema.TaggedErrorClass<SubagentNotFoundError>()("SubagentNotFoundError", {
  id: Schema.String,
}) {}

export interface SubagentInterface {
  readonly spawn: (config: SubagentConfig) => Effect.Effect<SubagentStatus, SubagentError>
  readonly getStatus: (id: string) => Effect.Effect<SubagentStatus, SubagentNotFoundError>
  readonly wait: (id: string) => Effect.Effect<SubagentResult, SubagentError | SubagentNotFoundError>
  readonly cancel: (id: string) => Effect.Effect<void, SubagentNotFoundError>
  readonly list: () => Effect.Effect<SubagentStatus[]>
  readonly cleanup: (id: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, SubagentInterface>()("@nexus/Subagent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const subagents = new Map<string, SubagentStatus>()
    const children = new Map<string, ChildProcess>()

    const runAgent = (id: string, config: SubagentConfig) =>
      Effect.tryPromise({
        try: () =>
          new Promise<SubagentResult>((resolve, reject) => {
            const startedAt = Date.now()
            const entry = join(__dirname, "..", "index.ts")
            const args = [entry, "run", config.objective]
            if (config.model) args.push("--model", config.model)
            args.push("--dir", config.workingDirectory)

            const child = spawnProcess(process.execPath, args, {
              cwd: config.workingDirectory,
              env: { ...process.env, ...config.environment },
              stdio: ["ignore", "pipe", "pipe"],
            })
            children.set(id, child)

            let stdout = ""
            let stderr = ""
            const maxCapture = 16_000

            child.stdout?.on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8")
              if (stdout.length > maxCapture) stdout = stdout.slice(stdout.length - maxCapture)
            })
            child.stderr?.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8")
              if (stderr.length > maxCapture) stderr = stderr.slice(stderr.length - maxCapture)
            })
            child.on("error", (error) => {
              children.delete(id)
              reject(new SubagentError({ message: error.message, subagentId: id }))
            })
            child.on("close", (code) => {
              children.delete(id)
              const durationMs = Date.now() - startedAt
              const output = stdout.trim()
              const message = stderr.trim()
              resolve({
                id,
                success: code === 0,
                output,
                error: code === 0 ? undefined : message || `subagent exited with code ${code}`,
                turns: 0,
                durationMs,
              })
            })
          }),
        catch: (error) =>
          error instanceof SubagentError
            ? error
            : new SubagentError({ message: error instanceof Error ? error.message : String(error), subagentId: id }),
      })

    const spawn = Effect.fn("Subagent.spawn")(function* (config: SubagentConfig) {
      const id = config.id || randomUUID()
      const status: SubagentStatus = {
        id,
        name: config.name,
        state: "pending",
        objective: config.objective,
        workingDirectory: config.workingDirectory,
      }
      subagents.set(id, status)

      // Run the subagent in the background
      Effect.runFork(
        Effect.gen(function* () {
          const startedAt = Date.now()
          status.state = "running"
          status.startedAt = startedAt
          subagents.set(id, { ...status })

          const result = yield* runAgent(id, config)

          status.state = result.success ? "completed" : "failed"
          status.completedAt = Date.now()
          status.result = result
          subagents.set(id, { ...status })
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              const message =
                typeof error === "object" && error !== null && "message" in error
                  ? String((error as { message: unknown }).message)
                  : String(error)
              const errorResult: SubagentResult = {
                id,
                success: false,
                error: message,
                turns: 0,
                durationMs: Date.now() - (status.startedAt || Date.now()),
              }
              status.state = "failed"
              status.completedAt = Date.now()
              status.result = errorResult
              subagents.set(id, { ...status })
            }),
          ),
        ),
      )

      return status
    })

    const getStatus = Effect.fn("Subagent.getStatus")(function* (id: string) {
      const status = subagents.get(id)
      if (!status) {
        return yield* Effect.fail(new SubagentNotFoundError({ id }))
      }
      return status
    })

    const wait = Effect.fn("Subagent.wait")(function* (id: string) {
      const status = yield* getStatus(id)
      if (status.state === "completed" || status.state === "failed") {
        if (!status.result) {
          return yield* Effect.fail(new SubagentError({ message: "No result available", subagentId: id }))
        }
        return status.result
      }

      // Wait for completion with polling
      return yield* Effect.retry(
        Effect.gen(function* () {
          const s = yield* getStatus(id)
          if (s.state === "completed" || s.state === "failed") {
            if (!s.result) {
              return yield* Effect.fail(new SubagentError({ message: "No result available", subagentId: id }))
            }
            return s.result
          }
          return yield* Effect.fail(new SubagentError({ message: "Still running", subagentId: id }))
        }),
        {
          times: 100,
          schedule: Schedule.spaced("1 second"),
        },
      )
    })

    const cancel = Effect.fn("Subagent.cancel")(function* (id: string) {
      const status = subagents.get(id)
      if (!status) {
        return yield* Effect.fail(new SubagentNotFoundError({ id }))
      }
      if (status.state === "running" || status.state === "pending") {
        status.state = "cancelled"
        status.completedAt = Date.now()
        status.result = {
          id,
          success: false,
          error: "subagent cancelled",
          turns: 0,
          durationMs: Date.now() - (status.startedAt || Date.now()),
        }
        subagents.set(id, { ...status })
        children.get(id)?.kill()
        children.delete(id)
      }
    })

    const list = Effect.fn("Subagent.list")(function* () {
      return Array.from(subagents.values()).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
    })

    const cleanup = Effect.fn("Subagent.cleanup")(function* (id: string) {
      subagents.delete(id)
      children.get(id)?.kill()
      children.delete(id)
    })

    return Service.of({ spawn, getStatus, wait, cancel, list, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [],
})

export * as Subagent from "."
