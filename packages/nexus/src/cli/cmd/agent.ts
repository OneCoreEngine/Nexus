import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "@nexus-ai/core/global"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import {
  AgentPlatformStore,
  type GatewayChannel,
  type GatewayRuntimeMode,
  type LearningStatus,
  type MemoryKind,
  type MemoryScope,
  type MemorySyncPack,
} from "../../agent-platform/store"
import { openLocalBrowser, parseBrowserHandoffTarget } from "../../agent-platform/browser-handoff"
import {
  clearLocalGatewayState,
  defaultLocalGatewayStatePath,
  gatewayCredentialName,
  isLocalGatewayProcessRunning,
  pollTelegramOnce,
  readLocalGatewayState,
  startLocalGatewayServer,
  type GatewayCredentialKind,
} from "../../agent-platform/gateway-local"
import { planGatewayRun } from "../../agent-platform/gateway"
import { SecretStore } from "@nexus-ai/assistant/core/secret-store"
import {
  formatSpecialistRole,
  formatSpecialistRoles,
  specialistRoleNames,
  type SpecialistRoleName,
} from "./agent-roles"
import {
  agentCapabilitySections,
  agentCapabilityStatus,
  formatAgentCapabilityStatus,
  type AgentCapabilitySection,
} from "./agent-status"
import { collectDeviceReadiness } from "./device"
import { createAgentPlanPreview, formatAgentPlanPreview } from "./agent-plan-preview"

type AgentMode = "all" | "primary" | "subagent"

// Permission keys (not raw tool names). Multiple tools can map to a single
// permission — e.g. write/edit/apply_patch all gate on `edit` — so we configure
// agents at the permission level to match how the runtime actually enforces it.
const AVAILABLE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

const AgentCreateCommand = effectCmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools"],
        describe: `comma-separated list of permissions to allow (default: all). Available: "${AVAILABLE_PERMISSIONS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  handler: Effect.fn("Cli.agent.create")(function* (args) {
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const agentSvc = yield* Agent.Service
    const runLocalEffect = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
    yield* Effect.promise(async () => {
      const cliPath = args.path
      const cliDescription = args.description
      const cliMode = args.mode as AgentMode | undefined
      const perms = args.permissions

      const isFullyNonInteractive = cliPath && cliDescription && cliMode && perms !== undefined

      if (!isFullyNonInteractive) {
        UI.empty()
        prompts.intro("Create agent")
      }

      const project = ctx.project

      // Determine scope/path
      let targetPath: string
      if (cliPath) {
        targetPath = path.join(cliPath, "agents")
      } else {
        let scope: "global" | "project" = "global"
        if (project.vcs === "git") {
          const scopeResult = await prompts.select({
            message: "Location",
            options: [
              {
                label: "Current project",
                value: "project" as const,
                hint: ctx.worktree,
              },
              {
                label: "Global",
                value: "global" as const,
                hint: Global.Path.config,
              },
            ],
          })
          if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
          scope = scopeResult
        }
        targetPath = path.join(scope === "global" ? Global.Path.config : path.join(ctx.worktree, ".nexus"), "agents")
      }

      // Get description
      let description: string
      if (cliDescription) {
        description = cliDescription
      } else {
        const query = await prompts.text({
          message: "Description",
          placeholder: "What should this agent do?",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(query)) throw new UI.CancelledError()
        description = query
      }

      // Generate agent
      const spinner = prompts.spinner()
      spinner.start("Generating agent configuration...")
      const model = args.model ? Provider.parseModel(args.model) : undefined
      const generated = await runLocalEffect(agentSvc.generate({ description, model })).catch((error) => {
        spinner.stop(`LLM failed to generate agent: ${error.message}`, 1)
        if (isFullyNonInteractive) process.exit(1)
        throw new UI.CancelledError()
      })
      spinner.stop(`Agent ${generated.identifier} generated`)

      // Select permissions to allow
      let selected: string[]
      if (perms !== undefined) {
        selected = perms ? perms.split(",").map((t) => t.trim()) : AVAILABLE_PERMISSIONS
      } else {
        const result = await prompts.multiselect({
          message: "Select permissions to allow (Space to toggle)",
          options: AVAILABLE_PERMISSIONS.map((permission) => ({
            label: permission,
            value: permission,
          })),
          initialValues: AVAILABLE_PERMISSIONS,
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        selected = result
      }

      // Get mode
      let mode: AgentMode
      if (cliMode) {
        mode = cliMode
      } else {
        const modeResult = await prompts.select({
          message: "Agent mode",
          options: [
            {
              label: "All",
              value: "all" as const,
              hint: "Can function in both primary and subagent roles",
            },
            {
              label: "Primary",
              value: "primary" as const,
              hint: "Acts as a primary/main agent",
            },
            {
              label: "Subagent",
              value: "subagent" as const,
              hint: "Can be used as a subagent by other agents",
            },
          ],
          initialValue: "all" as const,
        })
        if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
        mode = modeResult
      }

      // Build permissions config — deny anything not explicitly selected.
      const permissions: Record<string, "deny"> = {}
      for (const permission of AVAILABLE_PERMISSIONS) {
        if (!selected.includes(permission)) {
          permissions[permission] = "deny"
        }
      }

      // Build frontmatter
      const frontmatter: {
        description: string
        mode: AgentMode
        permission?: Record<string, "deny">
      } = {
        description: generated.whenToUse,
        mode,
      }
      if (Object.keys(permissions).length > 0) {
        frontmatter.permission = permissions
      }

      // Write file
      const content = matter.stringify(generated.systemPrompt, frontmatter)
      const filePath = path.join(targetPath, `${generated.identifier}.md`)

      await fs.mkdir(targetPath, { recursive: true })

      if (await Filesystem.exists(filePath)) {
        if (isFullyNonInteractive) {
          console.error(`Error: Agent file already exists: ${filePath}`)
          process.exit(1)
        }
        prompts.log.error(`Agent file already exists: ${filePath}`)
        throw new UI.CancelledError()
      }

      await Filesystem.write(filePath, content)

      if (isFullyNonInteractive) {
        console.log(filePath)
      } else {
        prompts.log.success(`Agent created: ${filePath}`)
        prompts.outro("Done")
      }
    })
  }),
})

const AgentListCommand = effectCmd({
  command: "list",
  describe: "list all available agents",
  handler: Effect.fn("Cli.agent.list")(function* () {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  }),
})

const AgentRoleCommand = cmd({
  command: "role <operation> [role]",
  describe: "inspect first-party specialist role constraints without selecting or changing them",
  builder: (yargs: Argv) =>
    yargs
      .positional("operation", { choices: ["list", "show"] as const, describe: "inspect all roles or one role" })
      .positional("role", { choices: specialistRoleNames, describe: "role name required for show" })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  handler(args) {
    const format = args.format ?? "table"
    if (args.operation === "list") {
      process.stdout.write(formatSpecialistRoles(format === "json" ? "json" : "table") + EOL)
      return
    }
    if (!args.role) {
      UI.error("Role name required. Use: nexus agent role show <planner|coder|reviewer|tester>")
      process.exitCode = 1
      return
    }
    process.stdout.write(formatSpecialistRole(args.role, format === "json" ? "json" : "table") + EOL)
  },
})

function platformError(error: unknown) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}${EOL}`)
  process.exitCode = 1
}

const AgentMemoryCommand = cmd({
  command: "memory <operation> [query..]",
  describe: "manage local, redacted, cross-session agent memory",
  builder: (yargs: Argv) =>
    yargs
      .positional("operation", {
        choices: ["add", "list", "search", "replace", "delete", "export", "import"] as const,
        describe: "memory operation",
      })
      .positional("query", { type: "string", array: true, describe: "search text" })
      .option("content", { type: "string", describe: "memory text for add" })
      .option("scope", {
        choices: ["device", "project", "channel"] as const,
        default: "device",
        describe: "memory visibility scope",
      })
      .option("scope-id", { type: "string", default: "default", describe: "scope identifier" })
      .option("kind", {
        choices: ["fact", "preference", "decision", "summary", "instruction"] as const,
        default: "fact",
        describe: "memory classification",
      })
      .option("confidence", { type: "number", default: 0.8, describe: "confidence from 0 to 1" })
      .option("file", { type: "string", describe: "manual redacted memory sync-pack path for export or import" }),
  async handler(args: any) {
    const store = new AgentPlatformStore()
    try {
      const scope = args.scope as MemoryScope
      const scopeId = args.scopeId as string
      if (args.operation === "export" || args.operation === "import") {
        if (!args.file) throw new Error("Memory sync requires --file <path>")
        if (scope === "device")
          throw new Error(
            "Device-scoped memory cannot be synced. Select --scope project or --scope channel explicitly.",
          )
        if (args.operation === "export") {
          const pack = store.exportMemorySyncPack(scope, scopeId)
          await fs.writeFile(args.file, JSON.stringify(pack, null, 2) + "\n", "utf8")
          process.stdout.write(
            `Exported ${pack.records.length} redacted ${scope}:${scopeId} memory record(s) to ${args.file}. The pack contains no API vault keys, credentials, browser data, shell history, or project files.${EOL}`,
          )
          return
        }
        const pack = JSON.parse(await fs.readFile(args.file, "utf8")) as MemorySyncPack
        if (pack.scope !== scope || pack.scopeId !== scopeId)
          throw new Error(`Sync pack scope must match the explicit --scope ${scope} --scope-id ${scopeId} selection`)
        const imported = store.importMemorySyncPack(pack)
        process.stdout.write(
          `Imported ${imported.length} redacted ${scope}:${scopeId} memory record(s) from ${args.file}. Existing exact records were deduplicated.${EOL}`,
        )
        return
      }
      if (args.operation === "add") {
        if (!args.content) throw new Error('Memory content required. Use: nexus agent memory add --content "..."')
        const memory = store.addMemory({
          scope,
          scopeId,
          kind: args.kind as MemoryKind,
          content: args.content,
          confidence: args.confidence,
        })
        process.stdout.write(
          `Saved redacted ${memory.kind} memory ${memory.id} in ${memory.scope}:${memory.scopeId}${EOL}`,
        )
        return
      }
      const id = (args.query ?? [])[0]
      if (args.operation === "delete") {
        if (!id) throw new Error("Memory id required. Use: nexus agent memory delete <id>")
        store.deleteMemory(id)
        process.stdout.write(`Memory ${id} deleted locally. The audit record remains for accountability.${EOL}`)
        return
      }
      if (args.operation === "replace") {
        if (!id || !args.content)
          throw new Error(
            'Memory replacement requires an id and --content. Use: nexus agent memory replace <id> --content "..."',
          )
        const replacement = store.replaceMemory(id, { content: args.content, confidence: args.confidence })
        process.stdout.write(`Memory ${id} superseded by redacted replacement ${replacement.id}.${EOL}`)
        return
      }
      const memories =
        args.operation === "search"
          ? store.searchMemory((args.query ?? []).join(" "), scope, scopeId)
          : store.listMemory(scope, scopeId)
      if (!memories.length) {
        process.stdout.write(`No active memory in ${scope}:${scopeId}${EOL}`)
        return
      }
      for (const memory of memories)
        process.stdout.write(`${memory.id}\t${memory.kind}\t${memory.confidence}\t${memory.content}${EOL}`)
    } catch (error) {
      platformError(error)
    } finally {
      store.close()
    }
  },
})

const AgentLearningCommand = cmd({
  command: "learning <operation> [id]",
  describe: "review and approve reusable learning proposals; no proposal activates automatically",
  builder: (yargs: Argv) =>
    yargs
      .positional("operation", {
        choices: ["propose", "list", "approve", "reject", "skills", "revoke"] as const,
        describe: "learning operation",
      })
      .positional("id", { type: "string", describe: "proposal id for approve or reject" })
      .option("run", { type: "string", describe: "source run id for a proposal" })
      .option("title", { type: "string", describe: "proposal title" })
      .option("summary", { type: "string", describe: "proposal summary" })
      .option("skill", { type: "string", describe: "draft reusable skill text" })
      .option("status", {
        choices: ["proposed", "approved", "rejected", "superseded"] as const,
        describe: "optional list filter",
      }),
  async handler(args: any) {
    const store = new AgentPlatformStore()
    try {
      if (args.operation === "propose") {
        if (!args.run || !args.title || !args.skill) throw new Error("Proposal requires --run, --title, and --skill")
        const proposal = store.proposeLearning({
          runId: args.run,
          title: args.title,
          summary: args.summary ?? "",
          skillDraft: args.skill,
        })
        process.stdout.write(
          `Learning proposal ${proposal.id} saved as proposed. Review with: nexus agent learning approve ${proposal.id}${EOL}`,
        )
        return
      }
      if (args.operation === "approve") {
        if (!args.id) throw new Error("Proposal id required")
        store.approveLearning(args.id)
        process.stdout.write(`Learning proposal ${args.id} approved and revisioned${EOL}`)
        return
      }
      if (args.operation === "reject") {
        if (!args.id) throw new Error("Proposal id required")
        store.rejectLearning(args.id)
        process.stdout.write(`Learning proposal ${args.id} rejected${EOL}`)
        return
      }
      if (args.operation === "revoke") {
        if (!args.id) throw new Error("Skill revision id required")
        store.revokeSkillRevision(args.id)
        process.stdout.write(`Skill revision ${args.id} revoked. Its learning proposal is now superseded.${EOL}`)
        return
      }
      if (args.operation === "skills") {
        const skills = store.listSkillRevisions()
        if (!skills.length) process.stdout.write("No approved skill revisions found" + EOL)
        for (const skill of skills)
          process.stdout.write(
            `${skill.id}\trevision=${skill.revision}\t${skill.title}\tproposal=${skill.proposalId}${EOL}`,
          )
        return
      }
      const proposals = store.listLearning(args.status as LearningStatus | undefined)
      if (!proposals.length) process.stdout.write("No learning proposals found" + EOL)
      for (const proposal of proposals)
        process.stdout.write(`${proposal.id}\t${proposal.status}\t${proposal.title}\t${proposal.summary}${EOL}`)
    } catch (error) {
      platformError(error)
    } finally {
      store.close()
    }
  },
})

const AgentScheduleCommand = cmd({
  command: "schedule <operation> [id]",
  describe: "define local schedules; new schedules remain disabled until a later explicit enable flow",
  builder: (yargs: Argv) =>
    yargs
      .positional("operation", {
        choices: ["add", "list", "enable", "disable"] as const,
        describe: "schedule operation",
      })
      .positional("id", { type: "string", describe: "schedule id for enable or disable" })
      .option("name", { type: "string", describe: "unique schedule name" })
      .option("cron", { type: "string", describe: "cron expression" })
      .option("timezone", { type: "string", default: "UTC", describe: "IANA time zone" })
      .option("task", { type: "string", describe: "redacted task payload" })
      .option("confirm", {
        type: "boolean",
        default: false,
        describe: "explicitly confirm schedule activation or deactivation",
      }),
  async handler(args: any) {
    const store = new AgentPlatformStore()
    try {
      if (args.operation === "add") {
        if (!args.name || !args.cron || !args.task) throw new Error("Schedule requires --name, --cron, and --task")
        const schedule = store.createSchedule({
          name: args.name,
          expression: args.cron,
          timezone: args.timezone,
          payload: args.task,
        })
        process.stdout.write(
          `Schedule ${schedule.name} created disabled. It will not run until a gateway scheduler claims it after explicit enablement.${EOL}`,
        )
        return
      }
      if (args.operation === "enable" || args.operation === "disable") {
        if (!args.id) throw new Error("Schedule id required")
        store.setScheduleEnabled(args.id, { enabled: args.operation === "enable", confirmed: args.confirm === true })
        process.stdout.write(
          `Schedule ${args.id} ${args.operation === "enable" ? "enabled" : "disabled"}. A local CLI command does not start a hidden background scheduler.${EOL}`,
        )
        return
      }
      const schedules = store.listSchedules()
      if (!schedules.length) process.stdout.write("No agent schedules defined" + EOL)
      for (const schedule of schedules)
        process.stdout.write(
          `${schedule.id}\t${schedule.enabled ? "enabled" : "disabled"}\t${schedule.expression}\t${schedule.timezone}\t${schedule.name}${EOL}`,
        )
    } catch (error) {
      platformError(error)
    } finally {
      store.close()
    }
  },
})

const AgentGatewayCommand = cmd({
  command: "gateway <operation> [id]",
  describe: "register opt-in channel metadata and inspect gateway connection state; no raw bot token is accepted",
  builder: (yargs: Argv) =>
    yargs
      .positional("operation", {
        choices: [
          "register",
          "list",
          "enable",
          "disable",
          "credential-set",
          "local-start",
          "local-status",
          "local-stop",
          "telegram-poll",
        ] as const,
        describe: "gateway operation",
      })
      .positional("id", {
        type: "string",
        describe: "connection id for enable, disable, credential-set, or telegram-poll",
      })
      .option("channel", { choices: ["telegram", "discord", "slack"] as const, describe: "target chat platform" })
      .option("label", { type: "string", describe: "connection label" })
      .option("mode", {
        choices: ["local", "hosted"] as const,
        default: "local",
        describe: "local foreground mode by default; hosted is an explicit custom profile",
      })
      .option("credential-ref", {
        type: "string",
        describe: "opaque server credential reference such as credential://telegram/personal",
      })
      .option("allowed-sender", {
        type: "string",
        array: true,
        describe: "explicitly authorized channel sender id; repeat for each owner",
      })
      .option("kind", {
        choices: [
          "telegram-bot-token",
          "telegram-webhook-secret",
          "slack-signing-secret",
          "discord-public-key",
        ] as const,
        describe: "credential material class for credential-set",
      })
      .option("port", { type: "number", default: 8787, describe: "loopback-only local listener port for local-start" })
      .option("confirm", {
        type: "boolean",
        default: false,
        describe: "explicitly confirm connection enablement or disablement",
      }),
  async handler(args: any) {
    const store = new AgentPlatformStore()
    try {
      if (args.operation === "credential-set") {
        if (!args.id || !args.kind) throw new Error("Credential setup requires a connection id and --kind")
        const connection = store.listGatewayConnections().find((item) => item.id === args.id)
        if (!connection) throw new Error(`Gateway connection not found: ${args.id}`)
        const kind = args.kind as GatewayCredentialKind
        const secret = await prompts.password({
          message: `Enter ${kind} for ${connection.channel}; it is encrypted locally and never echoed`,
        })
        if (prompts.isCancel(secret)) throw new UI.CancelledError()
        if (!secret?.trim()) throw new Error("Credential value cannot be empty")
        SecretStore.setSecret(gatewayCredentialName(connection.id, kind), secret.trim())
        process.stdout.write(
          `Encrypted local credential material saved for ${connection.id}. No token was added to command history.${EOL}`,
        )
        return
      }
      if (args.operation === "local-status") {
        const state = readLocalGatewayState()
        if (!state) process.stdout.write("No foreground local gateway state is recorded." + EOL)
        else if (!isLocalGatewayProcessRunning(state.pid)) {
          clearLocalGatewayState()
          process.stdout.write("Removed stale local gateway state; no foreground gateway process is running." + EOL)
        } else
          process.stdout.write(
            `Local gateway recorded at http://${state.host}:${state.port} (pid ${state.pid}). It runs only while that user-started process remains alive.${EOL}`,
          )
        return
      }
      if (args.operation === "local-stop") {
        if (!args.confirm) throw new Error("Stopping a local gateway requires --confirm")
        const state = readLocalGatewayState()
        if (!state) {
          process.stdout.write("No foreground local gateway state is recorded." + EOL)
          return
        }
        if (!isLocalGatewayProcessRunning(state.pid)) {
          clearLocalGatewayState()
          process.stdout.write(`Removed stale local gateway state for non-running process ${state.pid}.${EOL}`)
          return
        }
        try {
          process.kill(state.pid, "SIGTERM")
          process.stdout.write(`Stop signal sent to local gateway process ${state.pid}.${EOL}`)
        } catch {
          throw new Error(
            `Local gateway process ${state.pid} is not running; remove only a confirmed-stale state file at ${defaultLocalGatewayStatePath()}`,
          )
        }
        return
      }
      if (args.operation === "local-start") {
        const runtime = await startLocalGatewayServer({
          store,
          port: args.port,
          credentialFor: (connectionId, kind) => SecretStore.getSecret(gatewayCredentialName(connectionId, kind)),
        })
        process.stdout.write(
          `Local gateway listening only at http://${runtime.state.host}:${runtime.state.port}. It is a foreground process; press Ctrl+C to stop it. No boot service or public tunnel was created.${EOL}`,
        )
        await new Promise<void>((resolve) => {
          const close = () => runtime.close().finally(resolve)
          process.once("SIGINT", close)
          process.once("SIGTERM", close)
        })
        return
      }
      if (args.operation === "telegram-poll") {
        if (!args.id) throw new Error("Telegram polling requires a local Telegram connection id")
        const connection = store.listGatewayConnections().find((item) => item.id === args.id)
        if (!connection || connection.channel !== "telegram" || connection.runtimeMode !== "local")
          throw new Error("Telegram polling requires an enabled local Telegram connection")
        if (!connection.enabled) throw new Error("Enable this Telegram connection with --confirm before polling")
        const token = SecretStore.getSecret(gatewayCredentialName(connection.id, "telegram-bot-token"))
        if (!token)
          throw new Error(
            `No encrypted Telegram bot token is stored. Use: nexus agent gateway credential-set ${connection.id} --kind telegram-bot-token`,
          )
        let offset: number | undefined
        let stopped = false
        const stop = () => {
          stopped = true
        }
        process.once("SIGINT", stop)
        process.once("SIGTERM", stop)
        process.stdout.write(
          `Polling Telegram in the foreground for local connection ${connection.id}. Press Ctrl+C to stop; no background service was created.${EOL}`,
        )
        try {
          while (!stopped) {
            const result = await pollTelegramOnce({
              token,
              offset,
              onUpdate: (event) => planGatewayRun(store, { schemaVersion: 1, connectionId: connection.id, ...event }),
            })
            offset = result.nextOffset
          }
        } finally {
          process.off("SIGINT", stop)
          process.off("SIGTERM", stop)
        }
        return
      }
      if (args.operation === "register") {
        if (
          !args.channel ||
          !args.label ||
          !args.credentialRef ||
          !(args.allowedSender as string[] | undefined)?.length
        ) {
          throw new Error(
            "Gateway registration requires --channel, --label, --credential-ref, and at least one --allowed-sender",
          )
        }
        const connection = store.registerGatewayConnection({
          channel: args.channel as GatewayChannel,
          label: args.label,
          runtimeMode: args.mode as GatewayRuntimeMode,
          credentialRef: args.credentialRef,
          allowedSenders: args.allowedSender as string[],
        })
        process.stdout.write(
          `Gateway connection ${connection.id} registered disabled for ${connection.channel} in ${connection.runtimeMode} mode. Store the bot/app secret in encrypted local storage or the chosen hosted credential store, not this command.${EOL}`,
        )
        return
      }
      if (args.operation === "enable" || args.operation === "disable") {
        if (!args.id) throw new Error("Gateway connection id required")
        if (!args.confirm) throw new Error("Gateway connection changes require --confirm")
        store.setGatewayConnectionEnabled(args.id, args.operation === "enable")
        process.stdout.write(
          `Gateway connection ${args.id} ${args.operation === "enable" ? "enabled" : "disabled"}.${EOL}`,
        )
        return
      }
      const connections = store.listGatewayConnections()
      if (!connections.length) process.stdout.write("No gateway connections registered" + EOL)
      for (const connection of connections)
        process.stdout.write(
          `${connection.id}\t${connection.channel}\t${connection.runtimeMode}\t${connection.enabled ? "enabled" : "disabled"}\t${connection.label}\tallowed=${connection.allowedSenders.length}${EOL}`,
        )
    } catch (error) {
      platformError(error)
    } finally {
      store.close()
    }
  },
})

const AgentBrowserCommand = cmd({
  command: "browser <operation> [id]",
  describe: "open an explicitly approved local browser page and record human-controlled handoff checkpoints",
  builder: (yargs: Argv) =>
    yargs
      .positional("operation", {
        choices: ["start", "list", "resume", "complete", "cancel"] as const,
        describe: "browser handoff operation",
      })
      .positional("id", { type: "string", describe: "browser handoff id for resume, complete, or cancel" })
      .option("url", { type: "string", describe: "explicit http(s) URL to open locally for start" })
      .option("purpose", { type: "string", describe: "non-sensitive reason for the browser handoff" })
      .option("confirm", {
        type: "boolean",
        default: false,
        describe: "confirm this local browser handoff or state transition",
      }),
  async handler(args: any) {
    const store = new AgentPlatformStore()
    try {
      if (args.operation === "start") {
        if (!args.confirm) throw new Error("Opening a browser handoff requires --confirm")
        if (!args.url || !args.purpose) throw new Error("Browser handoff start requires --url and --purpose")
        const target = parseBrowserHandoffTarget(args.url)
        const handoff = store.createBrowserHandoff({ origin: target.origin, purpose: args.purpose })
        try {
          await openLocalBrowser(target.launchUrl)
        } catch (error) {
          store.transitionBrowserHandoff(handoff.id, "cancel")
          throw error
        }
        process.stdout.write(
          `Opened ${handoff.origin} in your local browser. Handoff ${handoff.id} is awaiting you.${EOL}`,
        )
        process.stdout.write(
          `Complete login, password/OTP/CAPTCHA, private data entry, declarations, payments, and final submission yourself in the browser. Then run: nexus agent browser resume ${handoff.id} --confirm${EOL}`,
        )
        return
      }
      if (args.operation === "list") {
        const handoffs = store.listBrowserHandoffs()
        if (!handoffs.length) process.stdout.write("No local browser handoffs recorded" + EOL)
        for (const handoff of handoffs)
          process.stdout.write(`${handoff.id}\t${handoff.status}\t${handoff.origin}\t${handoff.purpose}${EOL}`)
        return
      }
      if (!args.id) throw new Error(`Browser handoff id required for ${args.operation}`)
      if (!args.confirm) throw new Error(`Browser handoff ${args.operation} requires --confirm`)
      const handoff = store.transitionBrowserHandoff(args.id, args.operation as "resume" | "complete" | "cancel")
      if (args.operation === "resume") {
        process.stdout.write(
          `Handoff ${handoff.id} resumed. This records only your confirmation; NEXUS did not inspect the browser, read credentials, or verify a website state.${EOL}`,
        )
      } else if (args.operation === "complete") {
        process.stdout.write(
          `Handoff ${handoff.id} recorded as completed by you. NEXUS did not submit or verify any external form or action.${EOL}`,
        )
      } else {
        process.stdout.write(`Handoff ${handoff.id} cancelled locally. No browser data was retained.${EOL}`)
      }
    } catch (error) {
      platformError(error)
    } finally {
      store.close()
    }
  },
})

const AgentRunCommand = cmd({
  command: "run <operation>",
  describe: "plan bounded local subagent work; planning does not start hidden background execution",
  builder: (yargs: Argv) =>
    yargs
      .positional("operation", { choices: ["plan", "list"] as const, describe: "run operation" })
      .option("children", { type: "number", default: 2, describe: "maximum child agents, from 0 to 12" })
      .option("parallel", { type: "number", default: 3, describe: "maximum total parallel agents, from 1 to 12" })
      .option("budget", {
        choices: ["low", "standard", "high"] as const,
        default: "standard",
        describe: "execution budget class",
      })
      .option("idempotency-key", { type: "string", describe: "optional replay-safe planning key" }),
  async handler(args: any) {
    const store = new AgentPlatformStore()
    try {
      if (args.operation === "plan") {
        const run = store.createRun({
          idempotencyKey: args.idempotencyKey,
          policy: { maxChildren: args.children, maxParallel: args.parallel, budgetClass: args.budget },
        })
        process.stdout.write(
          `Planned local run ${run.id}: lead + up to ${run.policy.maxChildren} children, max ${run.policy.maxParallel} parallel. No background work started.${EOL}`,
        )
        return
      }
      const runs = store.listRuns()
      if (!runs.length) process.stdout.write("No durable agent runs planned" + EOL)
      for (const run of runs)
        process.stdout.write(
          `${run.id}\t${run.status}\t${run.policy.budgetClass}\tchildren=${run.policy.maxChildren}\tparallel=${run.policy.maxParallel}${EOL}`,
        )
    } catch (error) {
      platformError(error)
    } finally {
      store.close()
    }
  },
})

const AgentStatusCommand = cmd({
  command: "status",
  describe: "inspect local learning, scheduler, subagent, and gateway capability metadata without starting anything",
  builder: (yargs) =>
    yargs
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" })
      .option("section", {
        choices: agentCapabilitySections,
        describe: "inspect exactly one redacted capability area",
      }),
  async handler(args) {
    const store = new AgentPlatformStore()
    try {
      const status = agentCapabilityStatus({
        learning: store.listLearning(),
        skillRevisions: store.listSkillRevisions(),
        schedules: store.listSchedules(),
        runs: store.listRuns(),
        gateways: store.listGatewayConnections(),
        device: await collectDeviceReadiness(),
        localGatewayState: readLocalGatewayState(),
      })
      process.stdout.write(
        formatAgentCapabilityStatus(status, args.format === "json" ? "json" : "table", args.section) + EOL,
      )
    } catch (error) {
      platformError(error)
    } finally {
      store.close()
    }
  },
})

const AgentPlanPreviewCommand = cmd({
  command: "plan-preview <role>",
  describe: "preview a bounded local subagent policy without creating a run or starting work",
  builder: (yargs) =>
    yargs
      .positional("role", { choices: specialistRoleNames, describe: "existing specialist role to inspect" })
      .option("children", { type: "number", default: 0, describe: "maximum child agents to preview, from 0 to 12" })
      .option("parallel", {
        type: "number",
        default: 1,
        describe: "maximum total parallel agents to preview, from 1 to 12",
      })
      .option("budget", {
        choices: ["low", "standard", "high"] as const,
        default: "standard",
        describe: "preview-only budget class",
      })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  async handler(args) {
    if (!args.role) throw new Error("Role is required")
    const preview = createAgentPlanPreview({
      role: args.role,
      children: args.children ?? 0,
      parallel: args.parallel ?? 1,
      budget: args.budget === "low" || args.budget === "high" ? args.budget : "standard",
      device: await collectDeviceReadiness(),
    })
    process.stdout.write(formatAgentPlanPreview(preview, args.format === "json" ? "json" : "table") + EOL)
  },
})

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) =>
    yargs
      .command(AgentCreateCommand)
      .command(AgentListCommand)
      .command(AgentRoleCommand)
      .command(AgentMemoryCommand)
      .command(AgentLearningCommand)
      .command(AgentScheduleCommand)
      .command(AgentGatewayCommand)
      .command(AgentBrowserCommand)
      .command(AgentRunCommand)
      .command(AgentStatusCommand)
      .command(AgentPlanPreviewCommand)
      .demandCommand(),
  async handler() {},
})
