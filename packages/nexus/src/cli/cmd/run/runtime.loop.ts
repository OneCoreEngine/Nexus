// Single-writer interactive loop with a live communication side channel.
//
// Status questions are answered immediately from the active task snapshot. Any
// other prompt interrupts the active model turn and is handed off only after
// that turn settles; multiple inputs during the handoff are coalesced into one
// steering instruction instead of being placed in a FIFO prompt queue. This
// keeps session/tool execution serial while making live input responsive.
import * as Locale from "@/util/locale"
import { MessageID } from "@/session/schema"
import { isExitCommand, isNewCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent, RunPrompt, RunPromptPart } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error?: unknown) => void
}

export type InteractiveLoopInput = {
  footer: FooterApi
  initialInput?: string
  trace?: Trace
  onSend?: (prompt: RunPrompt) => void
  onNewSession?: () => void | Promise<void>
  getLiveStatus?: () => string
  run: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
}

type State = {
  handoff?: RunPrompt
  active?: RunPrompt
  ctrl?: AbortController
  closed: boolean
}

function acknowledgement(prompt: RunPrompt): string {
  if (prompt.mode === "shell") return "Running command…"
  if (prompt.command) return `Running /${prompt.command.name}…`
  return "Got it — working on it…"
}

function isLiveStatusRequest(text: string): boolean {
  const value = text.trim()
  return /^(?:\/(?:status|progress)\b|(?:please\s+)?(?:status|progress)(?:\s+update)?|what(?:'s|\s+is)\s+(?:the\s+)?(?:status|progress)|what\s+are\s+you\s+doing|any\s+(?:quick\s+)?update(?:\s+please)?|is\s+(?:it|the\s+(?:task|work|run))\s+(?:still\s+)?(?:running|done|finished|complete)(?:\s+yet)?|how\s+(?:is\s+it\s+going|far\s+along\s+is\s+the\s+(?:task|work))|kya\s+(?:status|progress)(?:\s+(?:hai|batao))?|(?:abhi\s+)?kya\s+kar\s+rahe\s+ho|kitna\s+(?:kaam|progress)\s+(?:hua|huwa))\s*[?.!]*$/iu.test(
    value,
  )
}

function mergeSteering(current: RunPrompt | undefined, next: RunPrompt): RunPrompt {
  if (!current) return next
  const prefix = `${current.text}\n\nAdditional live instruction:\n`
  const offset = Bun.stringWidth(prefix)
  return {
    ...current,
    text: `${prefix}${next.text}`,
    parts: [...current.parts, ...next.parts.map((part) => shiftPromptPart(part, offset))],
  }
}

function shiftPromptPart(part: RunPromptPart, offset: number): RunPromptPart {
  if (part.type === "agent" && part.source) {
    return {
      ...part,
      source: {
        ...part.source,
        start: part.source.start + offset,
        end: part.source.end + offset,
      },
    }
  }

  if (part.type === "file" && part.source?.text) {
    return {
      ...part,
      source: {
        ...part.source,
        text: {
          ...part.source.text,
          start: part.source.text.start + offset,
          end: part.source.text.end + offset,
        },
      },
    }
  }

  return part
}

function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

function statusReply(active: RunPrompt, status: string, handoff: boolean): string {
  const task = active.text.trim().replaceAll(/\s+/g, " ")
  const detail = status.trim() || "working; no detailed step is currently reported"
  const next = handoff ? " A live steering update is waiting for the active turn to settle." : ""
  return `Live status: ${detail}. Active task: ${task}. This status reply did not interrupt the task.${next}`
}

// Runs the interactive turn loop until the footer closes. The loop has one
// active session writer. New status questions use the side channel; other live
// inputs cancel the current turn and take over at the next settled boundary.
export async function runInteractiveLoop(input: InteractiveLoopInput): Promise<void> {
  const stop = defer<{ type: "closed" }>()
  const done = defer()
  const state: State = {
    closed: input.footer.isClosed,
  }
  let draining: Promise<void> | undefined

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const appendSystem = (text: string) => {
    const commit = {
      kind: "system",
      text,
      phase: "progress",
      source: "system",
    } as const
    input.trace?.write("ui.commit", commit)
    input.footer.append(commit)
  }

  const finish = () => {
    if (state.closed && !draining) done.resolve()
  }

  const close = () => {
    if (state.closed) return
    state.closed = true
    state.handoff = undefined
    state.ctrl?.abort()
    stop.resolve({ type: "closed" })
    finish()
  }

  const drain = () => {
    if (draining || state.closed || !state.handoff) return

    draining = (async () => {
      try {
        while (!state.closed && state.handoff) {
          const prompt = state.handoff
          state.handoff = undefined

          if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
            if (!input.onNewSession) {
              appendSystem("New sessions are unavailable in this run.")
              continue
            }

            emit(
              {
                type: "stream.patch",
                patch: { phase: "running", status: "starting new session" },
              },
              { phase: "running", status: "starting new session" },
            )
            await input.onNewSession()
            continue
          }

          const sent =
            prompt.mode === "shell" ? prompt : { ...prompt, messageID: prompt.messageID ?? MessageID.ascending() }
          state.active = sent
          const ctrl = new AbortController()
          state.ctrl = ctrl
          const start = Date.now()

          emit({ type: "turn.send", queue: 0 }, { phase: "running", status: "sending prompt", queue: 0 })

          try {
            await input.footer.idle()
            if (state.closed) break

            if (sent.mode !== "shell") {
              const commit = {
                kind: "user",
                text: sent.text,
                phase: "start",
                source: "system",
                messageID: sent.messageID,
              } as const
              input.trace?.write("ui.commit", commit)
              input.footer.append(commit)
            }

            appendSystem(acknowledgement(sent))
            input.onSend?.(sent)

            if (state.closed) break

            const result = await Promise.race([
              input.run(sent, ctrl.signal).then(
                () => ({ type: "done" as const }),
                (error) => ({ type: "error" as const, error }),
              ),
              stop.promise,
            ])

            if (result.type === "closed") {
              ctrl.abort()
              break
            }
            if (result.type === "error" && !ctrl.signal.aborted) {
              throw result.error
            }
          } finally {
            if (state.ctrl === ctrl) state.ctrl = undefined
            if (sent.mode !== "shell") {
              emit(
                { type: "turn.duration", duration: Locale.duration(Math.max(0, Date.now() - start)) },
                { duration: Locale.duration(Math.max(0, Date.now() - start)) },
              )
            }
            state.active = undefined
          }
        }
      } catch (error) {
        done.reject(error)
        return
      } finally {
        draining = undefined
        emit({ type: "turn.idle", queue: 0 }, { phase: "idle", status: "", queue: 0 })
      }

      finish()
      // A prompt may arrive as the active turn is settling. Start it after the
      // previous run has fully returned, never concurrently with it.
      if (state.handoff && !state.closed) drain()
    })()
  }

  const submit = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) return

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    if (prompt.mode !== "shell" && isLiveStatusRequest(prompt.text)) {
      const status = input.getLiveStatus?.() ?? ""
      if (state.active) {
        appendSystem(statusReply(state.active, status, Boolean(state.handoff)))
      } else if (status.trim()) {
        appendSystem(`Live status: ${status.trim()}. No model turn is currently running.`)
      } else {
        appendSystem("Live status: idle. No task is currently running.")
      }
      return
    }

    state.handoff = mergeSteering(state.handoff, prompt)
    if (state.active) {
      appendSystem(
        "Live steering received. The active turn is stopping safely; your instruction will take over at the next turn boundary.",
      )
      state.ctrl?.abort()
      return
    }

    drain()
  }

  const offPrompt = input.footer.onPrompt(submit)
  const offClose = input.footer.onClose(close)

  try {
    if (state.closed) return
    submit({ text: input.initialInput ?? "", parts: [] })
    finish()
    await done.promise
  } finally {
    offPrompt()
    offClose()
    close()
    await draining?.catch(() => {})
  }
}
