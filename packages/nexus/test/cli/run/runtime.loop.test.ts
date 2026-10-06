import { describe, expect, test } from "bun:test"
import { runInteractiveLoop } from "@/cli/cmd/run/runtime.loop"
import type { FooterApi, FooterEvent, RunPrompt, StreamCommit } from "@/cli/cmd/run/types"

function footer() {
  const prompts = new Set<(input: RunPrompt) => void>()
  const queuedRemoves = new Set<(messageID: string) => void>()
  const closes = new Set<() => void>()
  const events: FooterEvent[] = []
  const commits: StreamCommit[] = []
  let closed = false

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt(fn) {
      prompts.add(fn)
      return () => {
        prompts.delete(fn)
      }
    },
    onQueuedRemove(fn) {
      queuedRemoves.add(fn)
      return () => {
        queuedRemoves.delete(fn)
      }
    },
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
    },
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      for (const fn of [...closes]) {
        fn()
      }
    },
    destroy() {
      api.close()
      prompts.clear()
      closes.clear()
    },
  }

  return {
    api,
    events,
    commits,
    submit(text: string, mode?: RunPrompt["mode"], parts: RunPrompt["parts"] = []) {
      const next = mode ? { text, parts, mode } : { text, parts }
      for (const fn of [...prompts]) {
        fn(next)
      }
    },
    removeQueued(messageID: string) {
      for (const fn of [...queuedRemoves]) fn(messageID)
    },
  }
}

describe("run runtime interactive loop", () => {
  test("ignores empty prompts", async () => {
    const ui = footer()
    let calls = 0

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async () => {
        calls += 1
      },
    })

    ui.submit("   ")
    ui.api.close()
    await task

    expect(calls).toBe(0)
  })

  test("treats /exit as a close command", async () => {
    const ui = footer()
    let calls = 0

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async () => {
        calls += 1
      },
    })

    ui.submit("/exit")
    await task

    expect(calls).toBe(0)
  })

  test("treats /new as a local session command", async () => {
    const ui = footer()
    const seen: string[] = []
    let created = 0

    const task = runInteractiveLoop({
      footer: ui.api,
      onNewSession: async () => {
        created += 1
      },
      run: async (input) => {
        seen.push(input.text)
        ui.api.close()
      },
    })

    ui.submit("/new")
    ui.submit("hello")
    await task

    expect(created).toBe(1)
    expect(seen).toEqual(["hello"])
    expect(ui.commits).toEqual([
      {
        kind: "user",
        text: "hello",
        phase: "start",
        source: "system",
        messageID: expect.any(String),
      },
      {
        kind: "system",
        text: "Got it — working on it…",
        phase: "progress",
        source: "system",
      },
    ])
  })

  test("shell mode submits /exit as a shell command", async () => {
    const ui = footer()
    const seen: RunPrompt[] = []

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async (input) => {
        seen.push(input)
        ui.api.close()
      },
    })

    ui.submit("/exit", "shell")
    await task

    expect(seen).toEqual([{ text: "/exit", parts: [], mode: "shell" }])
    expect(ui.commits).toEqual([
      {
        kind: "system",
        text: "Running command…",
        phase: "progress",
        source: "system",
      },
    ])
  })

  test("shell mode submits /new instead of creating a session", async () => {
    const ui = footer()
    const seen: RunPrompt[] = []
    let created = 0

    const task = runInteractiveLoop({
      footer: ui.api,
      onNewSession: async () => {
        created += 1
      },
      run: async (input) => {
        seen.push(input)
        ui.api.close()
      },
    })

    ui.submit("/new", "shell")
    await task

    expect(created).toBe(0)
    expect(seen).toEqual([{ text: "/new", parts: [], mode: "shell" }])
    expect(ui.commits).toEqual([
      {
        kind: "system",
        text: "Running command…",
        phase: "progress",
        source: "system",
      },
    ])
  })

  test("shell mode does not append a synthetic user row", async () => {
    const ui = footer()

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async () => {
        expect(ui.commits).toEqual([
          {
            kind: "system",
            text: "Running command…",
            phase: "progress",
            source: "system",
          },
        ])
        ui.api.close()
      },
    })

    ui.submit("ls", "shell")
    await task
  })

  test("shell mode does not emit a turn duration summary", async () => {
    const ui = footer()

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async () => {
        ui.api.close()
      },
    })

    ui.submit("ls", "shell")
    await task

    expect(ui.events.some((event) => event.type === "turn.duration")).toBe(false)
  })

  test("preserves whitespace for initial input", async () => {
    const ui = footer()
    const seen: string[] = []

    await runInteractiveLoop({
      footer: ui.api,
      initialInput: "  hello  ",
      run: async (input) => {
        seen.push(input.text)
        ui.api.close()
      },
    })

    expect(seen).toEqual(["  hello  "])
    expect(ui.commits).toEqual([
      {
        kind: "user",
        text: "  hello  ",
        phase: "start",
        source: "system",
        messageID: expect.any(String),
      },
      {
        kind: "system",
        text: "Got it — working on it…",
        phase: "progress",
        source: "system",
      },
    ])
  })

  test("passes prompts to onSend", async () => {
    const ui = footer()
    const seen: string[] = []

    await runInteractiveLoop({
      footer: ui.api,
      initialInput: "  hello  ",
      onSend: (input) => {
        seen.push(input.text)
      },
      run: async () => {
        ui.api.close()
      },
    })

    expect(seen).toEqual(["  hello  "])
  })

  test("appends the user row before the turn starts", async () => {
    const ui = footer()

    await runInteractiveLoop({
      footer: ui.api,
      initialInput: "/fmt bash",
      run: async () => {
        expect(ui.commits).toEqual([
          {
            kind: "user",
            text: "/fmt bash",
            phase: "start",
            source: "system",
            messageID: expect.any(String),
          },
          {
            kind: "system",
            text: "Got it — working on it…",
            phase: "progress",
            source: "system",
          },
        ])
        ui.api.close()
      },
    })
  })

  test("answers live status questions immediately without interrupting the active turn", async () => {
    const ui = footer()
    const seen: string[] = []
    let activeSignal: AbortSignal | undefined

    const task = runInteractiveLoop({
      footer: ui.api,
      getLiveStatus: () => "running tool: tests",
      run: async (input, signal) => {
        seen.push(input.text)
        activeSignal = signal
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    ui.submit("Build the feature")
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(["Build the feature"])

    ui.submit("what is the status?")

    expect(activeSignal?.aborted).toBe(false)
    expect(seen).toEqual(["Build the feature"])
    expect(ui.commits.at(-1)?.text).toBe(
      "Live status: running tool: tests. Active task: Build the feature. This status reply did not interrupt the task.",
    )

    ui.api.close()
    await task
  })

  test("answers /status locally when no task is running", async () => {
    const ui = footer()
    const seen: string[] = []
    const task = runInteractiveLoop({
      footer: ui.api,
      run: async (input) => {
        seen.push(input.text)
      },
    })

    ui.submit("/status")
    expect(ui.commits.at(-1)?.text).toBe("Live status: idle. No task is currently running.")
    expect(seen).toEqual([])

    ui.api.close()
    await task
  })

  test("interrupts an active turn for live steering without overlapping task writers", async () => {
    const ui = footer()
    const seen: string[] = []
    let activeSignal: AbortSignal | undefined
    let running = 0
    let maximum = 0

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async (input, signal) => {
        seen.push(input.text)
        running += 1
        maximum = Math.max(maximum, running)
        try {
          if (seen.length === 1) {
            activeSignal = signal
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
          } else {
            ui.api.close()
          }
        } finally {
          running -= 1
        }
      },
    })

    ui.submit("Implement the first approach")
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(["Implement the first approach"])

    ui.submit("Change direction and use a smaller patch")
    expect(activeSignal?.aborted).toBe(true)
    expect(ui.commits.some((item) => item.text.startsWith("Live steering received."))).toBe(true)

    await task
    expect(seen).toEqual(["Implement the first approach", "Change direction and use a smaller patch"])
    expect(maximum).toBe(1)
  })

  test("coalesces rapid steering inputs into one handoff rather than retaining a FIFO", async () => {
    const ui = footer()
    const seen: string[] = []
    const seenParts: RunPrompt["parts"][] = []

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async (input, signal) => {
        seen.push(input.text)
        seenParts.push(input.parts)
        if (seen.length === 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
          return
        }

        ui.api.close()
      },
    })

    ui.submit("Long-running task")
    await Promise.resolve()
    await Promise.resolve()
    ui.submit("Use @tester", undefined, [
      { type: "agent", name: "tester", source: { start: 4, end: 11, value: "@tester" } },
    ])
    ui.submit("Also @coder", undefined, [
      { type: "agent", name: "coder", source: { start: 5, end: 11, value: "@coder" } },
    ])
    ui.submit("Also keep the test small")

    await task
    expect(seen).toEqual([
      "Long-running task",
      "Use @tester\n\nAdditional live instruction:\nAlso @coder\n\nAdditional live instruction:\nAlso keep the test small",
    ])
    const agents = seenParts[1]?.filter((part) => part.type === "agent")
    const offset = Bun.stringWidth("Use @tester\n\nAdditional live instruction:\n")
    expect(agents?.map((part) => (part.type === "agent" ? [part.source?.start, part.source?.end] : []))).toEqual([
      [4, 11],
      [offset + 5, offset + 11],
    ])
    expect(ui.commits.filter((item) => item.text.startsWith("Live steering received.")).length).toBe(3)
  })

  test("close aborts the active run and drops the pending steering handoff", async () => {
    const ui = footer()
    const seen: string[] = []
    let hit = false

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async (input, signal) => {
        seen.push(input.text)
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            hit = true
            resolve()
            return
          }

          signal.addEventListener(
            "abort",
            () => {
              hit = true
              resolve()
            },
            { once: true },
          )
        })
      },
    })

    ui.submit("one")
    await Promise.resolve()
    ui.submit("two")
    ui.api.close()
    await task

    expect(hit).toBe(true)
    expect(seen).toEqual(["one"])
  })

  test("propagates run errors", async () => {
    const ui = footer()

    const task = runInteractiveLoop({
      footer: ui.api,
      run: async () => {
        throw new Error("boom")
      },
    })

    ui.submit("one")
    await expect(task).rejects.toThrow("boom")
  })
})
