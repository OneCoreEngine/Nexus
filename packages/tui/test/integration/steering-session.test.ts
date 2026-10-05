/**
 * Session-path integration coverage for active-task steering, through real
 * Solid reactivity and the real production stores/coordinator — the same
 * wiring the session route mounts (status effect → acquireDispatch → editor
 * submit), driven headlessly so it runs identically in a clean audited
 * environment with no renderer or network.
 */
import { expect, test } from "bun:test"
// The plain "solid-js" entry resolves to the server build under Bun/Node test
// conditions, where createEffect is a no-op. Import the real client runtime
// directly so this harness exercises genuine reactivity.
// @ts-ignore -- deep path intentionally bypasses package export conditions
import { createEffect, createSignal } from "solid-js/dist/solid.js"
import {
  acquireDispatch,
  pendingPrompts,
  releaseDispatchFailed,
  resetSteeringState,
  steeringFlow,
} from "../../src/prompt/steering-queue"
import { steerActiveTask, type SteeringDeps } from "../../src/util/steering-flow"
import { STEERING_ACK, steeringStatusLine } from "../../src/util/steering"
import { steeringQueueLabel } from "../../src/routes/session/index"

/** Lets Solid's scheduler drain queued effects deterministically. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

type Harness = ReturnType<typeof createSessionHarness>

/**
 * Mirrors the production route wiring: a status signal stands in for
 * `sync.data.session_status[sessionID]`, the dispatch effect is the exact
 * logic used by routes/session/index.tsx, and the prompt "editor" records
 * what the normal submit path would receive.
 */
function createSessionHarness(overrides: Partial<SteeringDeps> = {}) {
  resetSteeringState()
  const sessionID = "ses_integration"
  const timeline: string[] = []
  const acks: string[] = []
  let editorInput: string | undefined
  let submits = 0

  const [statusType, setStatusType] = createSignal<"idle" | "busy" | "retry">("idle")
  const [editorBlocked, setEditorBlocked] = createSignal(false)
  const [queueVersion, setQueueVersion] = createSignal(0)
  pendingPrompts.subscribe(() => setQueueVersion((version: number) => version + 1))
  const queued = () => {
    queueVersion()
    return pendingPrompts.list(sessionID)
  }

  // Exact dispatch logic from routes/session/index.tsx: plain tracked effect
  // over idle status, editor availability, and queue presence.
  createEffect(() => {
    const type = statusType()
    const idle = type === "idle"
    if (!idle) {
      steeringFlow.settle(sessionID)
      return
    }
    const usable = !editorBlocked()
    const item = acquireDispatch(sessionID, idle, usable)
    if (!item) return
    if (editorBlocked()) {
      releaseDispatchFailed(item)
      return
    }
    editorInput = item.input
    submits += 1
    timeline.push(`dispatch:${item.input}`)
    // The dispatched prompt makes the session busy again.
    setStatusType("busy")
  })

  const deps: SteeringDeps = {
    currentStage: () => "Running tool…",
    abort: async () => {
      await flush()
      timeline.push("abort")
    },
    ack: (message) => {
      acks.push(message)
      timeline.push("ack")
    },
    abortFailed: () => timeline.push("abort-failed"),
    askChangeChoice: async () => "replace" as const,
    enqueue: (item) => pendingPrompts.add({ sessionID, ...item }),
    clearInput: () => {
      editorInput = undefined
    },
    ...overrides,
  }

  /** The interception seam inside Prompt.submitInner: busy sessions steer locally. */
  async function submit(text: string, parts: readonly unknown[] = []) {
    if (statusType() === "idle") {
      timeline.push(`send:${text}`)
      setStatusType("busy")
      return { handled: false }
    }
    await steerActiveTask(text, parts, deps)
    return { handled: true }
  }

  return {
    sessionID,
    deps,
    submit,
    acks,
    timeline,
    queued,
    submits: () => submits,
    editorInput: () => editorInput,
    setStatusType,
    setEditorBlocked,
    canDispatchNow: () => steeringFlow.shouldDispatch(sessionID),
  }
}

test("pending steering uses a neutral label and never renders QUEUED", () => {
  expect(steeringQueueLabel("followup")).toBe("pending:")
  expect(steeringQueueLabel("next")).toBe("next:")
  expect(steeringQueueLabel("followup")).not.toContain("queued")
})

test("new message during an active turn is acknowledged immediately, before abort settles", async () => {
  const h = createSessionHarness()
  h.setStatusType("busy")

  const promise = h.submit("stop now")
  // Acknowledgement is synchronous-local: it lands before the awaited abort.
  expect(h.timeline).toEqual(["ack"])
  expect(h.acks).toEqual([STEERING_ACK.stop])
  await promise
  expect(h.timeline).toEqual(["ack", "abort"])
})

test("abort failure keeps the editor text and queues/dispatches no phantom prompt", async () => {
  const failing = createSessionHarness()
  failing.setStatusType("busy")
  failing.deps.abort = async () => {
    throw new Error("offline")
  }

  const result = await steerActiveTask("stop now", [], failing.deps)
  expect(result).toEqual({ action: "stop", aborted: false, queued: 0 })
  expect(failing.acks).toEqual([STEERING_ACK.stop])
  expect(failing.timeline).toContain("abort-failed")
  expect(failing.queued().length).toBe(0)

  failing.setStatusType("idle")
  await flush()
  expect(failing.submits()).toBe(0)

  // Same guarantee when a stop carries extra task text: nothing may fire.
  const h2 = createSessionHarness()
  h2.setStatusType("busy")
  h2.deps.abort = async () => {
    throw new Error("offline")
  }
  await steerActiveTask("cancel the task, deploy staging", [{ type: "file" }], h2.deps)
  expect(h2.queued().length).toBe(0)
  h2.setStatusType("idle")
  await flush()
  expect(h2.submits()).toBe(0)
})

test("ordinary follow-up stays queued, then dispatches exactly once at the safe idle point", async () => {
  const h = createSessionHarness()
  h.setStatusType("busy")

  await h.submit("please also run the lint")
  expect(h.acks).toEqual([STEERING_ACK.followup])
  expect(h.queued().length).toBe(1)
  expect(h.submits()).toBe(0)

  // Active turn completes → single idle transition dispatches one item.
  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(1)
  expect(h.queued().length).toBe(0)
  expect(h.editorInput()).toBe("please also run the lint")
  expect(h.timeline).toContain("dispatch:please also run the lint")
})

test("each idle transition dispatches at most one queued item, never twice", async () => {
  const h = createSessionHarness()
  h.setStatusType("busy")
  await h.submit("first follow-up")
  await h.submit("second follow-up")
  expect(h.queued().length).toBe(2)

  // First idle transition: exactly one item leaves the queue.
  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(1)
  expect(h.editorInput()).toBe("first follow-up")

  // The dispatched turn re-marks the session busy; a lagging duplicate idle
  // event cannot dispatch anything extra while nothing is safely idle.
  h.setStatusType("idle")
  await flush()

  // Second idle transition dispatches the remaining item exactly once.
  h.setStatusType("busy")
  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(2)
  expect(h.editorInput()).toBe("second follow-up")

  // Empty queue: further idle events are no-ops.
  h.setStatusType("busy")
  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(2)
})

test("freeing a blocked editor while idle dispatches the pending item once", async () => {
  const h = createSessionHarness()
  h.setStatusType("busy")
  await h.submit("queued behind permission prompt")
  expect(h.queued().length).toBe(1)

  // Blocked editor while idle: nothing is consumed and nothing dispatches.
  h.setEditorBlocked(true)
  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(0)
  expect(h.queued().length).toBe(1)

  // Editor freed while still idle: tracked availability retriggers dispatch.
  h.setEditorBlocked(false)
  await flush()
  expect(h.submits()).toBe(1)
  expect(h.editorInput()).toBe("queued behind permission prompt")
  expect(h.queued().length).toBe(0)

  // No further dispatch without a new queued item.
  await flush()
  expect(h.submits()).toBe(1)
})

test("change dialog dismissal leaves task running, queue empty, and nothing dispatched later", async () => {
  let asked = 0
  const h = createSessionHarness({
    askChangeChoice: async () => {
      asked += 1
      return undefined
    },
  })
  h.setStatusType("busy")

  const result = await steerActiveTask("wait no, different plan", [], h.deps)
  expect(result.action).toBe("change-dismissed")
  expect(asked).toBe(1)
  expect(h.queued().length).toBe(0)
  expect(h.timeline).not.toContain("abort")

  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(0)
})

test("visible queue edit/remove mutates exactly what dispatch would send", async () => {
  const h = createSessionHarness()
  h.setStatusType("busy")
  await h.submit("editable instruction")

  // Visible: the queued entry is exposed to the timeline list rendering.
  const visible = h.queued()
  expect(visible.length).toBe(1)
  expect(visible[0]?.input).toBe("editable instruction")

  // Remove: drops only the targeted entry; nothing dispatches afterwards.
  pendingPrompts.remove(visible[0]!.id)
  expect(h.queued().length).toBe(0)
  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(0)

  // Edit semantics: remove-from-queue loads text back into the editor.
  h.setStatusType("busy")
  await h.submit("revised instruction")
  const [item] = h.queued()
  expect(item).toBeDefined()
  pendingPrompts.remove(item!.id)
  expect(h.queued().length).toBe(0)
  h.setStatusType("idle")
  await flush()
  expect(h.submits()).toBe(0)
})

test("acknowledgement contract is model-agnostic: identical for manual and Auto turns", async () => {
  for (const modelSelection of ["manual-model", "auto-selected-compatible-model"]) {
    const h = createSessionHarness({ currentStage: () => `stage-for-${modelSelection}` })
    h.setStatusType("busy")
    await h.submit("kya ho raha hai?")
    expect(h.acks.length).toBe(1)
    expect(h.acks[0]).toBe(steeringStatusLine(`stage-for-${modelSelection}`))

    const h2 = createSessionHarness()
    h2.setStatusType("busy")
    await h2.submit("follow-up while you work")
    expect(h2.acks).toEqual([STEERING_ACK.followup])
    expect(h2.queued()[0]?.input).toBe("follow-up while you work")
  }
})
