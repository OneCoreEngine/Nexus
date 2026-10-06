import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createVerificationReceipt,
  MasterAgent,
  isRiskyAction,
  replanFailedMasterStep,
  suggestAdaptiveMasterPlan,
  suggestMasterSteps,
} from "@/agent/master"
import { createCapabilityRegistry, upsertFeature } from "@/agent-platform/capability-registry"

const workspaces: string[] = []

afterEach(async () => {
  while (workspaces.length) await rm(workspaces.pop()!, { recursive: true, force: true })
})

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "nexus-master-agent-"))
  workspaces.push(path)
  return path
}

describe("MasterAgent", () => {
  test("uses verified capability records when planning new requirements", () => {
    const capabilities = {
      platform: "linux",
      architecture: "x64",
      termux: false,
      git: true,
      github: true,
      browserHandoff: true,
      browserHttpInspection: true,
      browserAutomation: true,
      webRuntime: true,
      android: true,
      androidDevice: false,
      apkBuild: true,
      packageManagers: ["bun"] as string[],
    } as const
    const registry = upsertFeature(createCapabilityRegistry(), {
      id: "browser-session",
      name: "browser",
      version: "1.0.0",
      status: "verified",
      summary: "secure browser session",
      files: ["agent-platform/browser-session.ts"],
      tests: ["browser-session.test.ts"],
      limitations: ["requires interactive adapter"],
    })
    const plan = suggestAdaptiveMasterPlan({ objective: "Test website UI and fix bugs", capabilities, registry })
    expect(plan.intent.requestedWorkers).toEqual(expect.arrayContaining(["browser", "web", "coder"]))
    expect(plan.missingFeatures).not.toContain("browser")
  })

  test("creates repair and verification follow-ups only for failed or blocked steps", () => {
    const followUps = replanFailedMasterStep({
      step: {
        id: "web",
        kind: "web",
        title: "Inspect website",
        status: "blocked",
        error: "Browser adapter unavailable",
        next: [],
      },
    })
    expect(followUps.map((step) => step.kind)).toEqual(["web", "tester"])
    expect(followUps[1]?.dependsOn).toEqual(["web-repair"])
    expect(
      replanFailedMasterStep({
        step: { id: "test", kind: "tester", title: "Run tests", status: "completed", error: undefined, next: [] },
      }),
    ).toEqual([])
  })

  test("appends runtime repair and verification steps only once", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    await agent.create("Fix a failing test")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])
    const failed = await agent.executeStep("test", async () => {
      throw new Error("failure")
    })
    expect(failed.status).toBe("failed")

    const replanned = await agent.replanFailedStep("test")
    expect(replanned.status).toBe("dispatching")
    expect(replanned.error).toBeUndefined()
    expect(replanned.steps.map((step) => step.id)).toEqual(["test", "test-repair", "test-verify"])
    expect(replanned.steps[1]?.dependsOn).toEqual(["test"])
    expect(replanned.steps[2]?.dependsOn).toEqual(["test-repair"])
    expect((await agent.replanFailedStep("test")).steps).toHaveLength(3)
  })

  test("suggests a coordinated specialist plan from the objective", () => {
    const steps = suggestMasterSteps(
      "Fix the web app, inspect it in the browser, test the APK, and prepare a GitHub PR",
    )

    expect(steps.map((step) => step.kind)).toEqual(["browser", "web", "android", "git", "coder", "reviewer", "tester"])
    expect(steps.at(-1)?.dependsOn).toEqual(["review"])
  })

  test("emits worker lifecycle events for live progress consumers", async () => {
    const root = await workspace()
    const events: string[] = []
    const agent = new MasterAgent({
      workspace: root,
      hooks: { onWorker: (event) => events.push(`${event.stepID}:${event.phase}:${event.attempt}`) },
    })
    await agent.create("Fix and test the project")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])
    await agent.executePlan(async () => ({ summary: "tests passed", verification: ["bun test: 3 passed"] }))

    expect(events).toEqual(["test:started:1", "test:completed:1"])
  })

  test("emits a redacted incident report for a terminal worker error", async () => {
    const root = await workspace()
    const incidents: string[] = []
    const agent = new MasterAgent({
      workspace: root,
      maxStepAttempts: 1,
      hooks: { onIncident: (report) => incidents.push(report.incidents[0]?.message ?? "") },
    })
    await agent.create("Fix a failing worker")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])
    await agent.executeStep("test", async () => {
      throw new Error("worker failed with api_key=private-token")
    })
    expect(incidents[0]).toContain("[REDACTED]")
    expect(incidents[0]).not.toContain("private-token")
  })

  test("emits retrying and failed events for a terminal worker error", async () => {
    const root = await workspace()
    const events: string[] = []
    const agent = new MasterAgent({
      workspace: root,
      maxStepAttempts: 3,
      hooks: { onWorker: (event) => events.push(`${event.phase}:${event.attempt}`) },
    })
    await agent.create("Fix a failing test")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])
    const state = await agent.executeStep("test", async () => {
      throw new Error("permanent failure")
    })

    expect(events).toEqual(["started:1", "retrying:1", "started:2", "failed:2"])
    expect(state.status).toBe("failed")
  })

  test("run creates a plan and dispatches it through the typed worker callback", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    const dispatched: string[] = []

    const result = await agent.run("Fix and test the project", async (request) => {
      dispatched.push(request.step.kind)
      return {
        summary: `${request.step.kind} completed`,
        changedFiles: [`${request.step.id}.ts`],
        verification: [`${request.step.id} test passed`],
        next: [`Review ${request.step.id}`],
      }
    })

    expect(dispatched).toEqual(["coder", "reviewer", "tester"])
    expect(result.steps[0]?.changedFiles).toEqual(["coder.ts"])
    expect(result.steps[0]?.verification).toEqual(["coder test passed"])
    expect(result.steps[0]?.next).toEqual(["Review coder"])
    expect(result.status).toBe("completed")
    expect(result.steps.every((step) => step.status === "completed")).toBe(true)
  })

  test("autoPlan persists the generated workflow", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    await agent.create("Research and fix a browser web app")

    const state = await agent.autoPlan()
    expect(state.status).toBe("planning")
    expect(state.steps.map((step) => step.id)).toEqual(["research", "browser", "web", "coder", "review", "test"])
  })

  test("detects risky actions without exposing secrets", () => {
    expect(isRiskyAction("git push origin main")).toBe(true)
    expect(isRiskyAction("sudo apt install gradle")).toBe(true)
    expect(isRiskyAction("read package.json and run tests")).toBe(false)
  })

  test("executes a dependency-ordered plan through a typed dispatcher", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    await agent.create("Inspect and verify")
    await agent.plan([
      { id: "inspect", kind: "research", title: "Inspect", dependsOn: [] },
      { id: "verify", kind: "tester", title: "Verify", dependsOn: ["inspect"] },
    ])

    const order: string[] = []
    const result = await agent.executePlan(async (request) => {
      order.push(request.step.id)
      return { summary: `completed ${request.step.id}`, verification: [`${request.step.id} evidence recorded`] }
    })

    expect(order).toEqual(["inspect", "verify"])
    expect(result.status).toBe("completed")
  })

  test("verification receipts are hashed and satisfy strict evidence requirements", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root, requireWorkerVerification: true })
    await agent.create("Verify the implementation")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    const receipt = createVerificationReceipt({ command: "bun test", exitCode: 0, output: "all tests passed" })
    const state = await agent.executeStep("test", async () => ({ summary: "verified", receipts: [receipt] }))

    expect(receipt.outputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(state.status).toBe("completed")
    expect(state.steps[0]?.receipts).toEqual([receipt])
  })

  test("strict verification blocks success without worker evidence", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root, requireWorkerVerification: true })
    await agent.create("Verify the implementation")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    const state = await agent.executeStep("test", async () => ({ summary: "tests probably passed" }))

    expect(state.status).toBe("blocked")
    expect(state.steps[0]?.status).toBe("blocked")
    expect(state.error).toContain("verification evidence")
  })

  test("blocks safely when a worker reports unavailable capability", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    await agent.create("Inspect an unsupported browser")
    await agent.plan([{ id: "browser", kind: "browser", title: "Inspect page", dependsOn: [] }])

    const state = await agent.executeStep("browser", async () => ({
      status: "blocked" as const,
      summary: "Browser inspection is unavailable on this device",
    }))

    expect(state.status).toBe("blocked")
    expect(state.steps[0]?.status).toBe("blocked")
    expect(state.steps[0]?.completedAt).toBeUndefined()
    expect(state.error).toBe("Browser inspection is unavailable on this device")
  })

  test("passes detected device capabilities to workers", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    await agent.create("Inspect the browser")
    await agent.plan([{ id: "browser", kind: "browser", title: "Inspect page", dependsOn: [] }])

    let received: string[] = []
    await agent.executeStep("browser", async (request) => {
      received = request.capabilities.packageManagers
      return { summary: "Capability check complete", verification: ["capabilities inspected"] }
    })

    expect(Array.isArray(received)).toBe(true)
  })

  test("stops repeated identical worker errors before exhausting retries", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root, maxStepAttempts: 5 })
    await agent.create("Fix the repeated failure")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    let attempts = 0
    const state = await agent.executeStep("test", async () => {
      attempts += 1
      throw new Error("same deterministic failure")
    })

    expect(attempts).toBe(2)
    expect(state.status).toBe("failed")
    expect(state.error).toContain("same error repeated")
    expect(state.steps[0]?.attempts).toBe(2)
  })

  test("checkpoints cancellation without retrying an aborted worker", async () => {
    const root = await workspace()
    const controller = new AbortController()
    const agent = new MasterAgent({ workspace: root, signal: controller.signal, maxStepAttempts: 5 })
    await agent.create("Cancel the task safely")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    const state = await agent.executeStep("test", async () => {
      controller.abort()
      throw new Error("aborted")
    })

    expect(state.status).toBe("cancelled")
    expect(state.steps[0]?.status).toBe("cancelled")
    expect(state.steps[0]?.attempts).toBe(1)
    expect(state.error).toBe("Worker cancelled by the caller")
  })

  test("checkpoints a plan and retries a failed worker within a bounded budget", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root, maxStepAttempts: 2 })
    await agent.create("Fix and test the project")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    let attempts = 0
    const state = await agent.executeStep("test", async () => {
      attempts += 1
      if (attempts === 1) throw new Error("temporary test runner failure")
      return { summary: "Focused tests passed", verification: ["bun test"] }
    })

    expect(attempts).toBe(2)
    expect(state.status).toBe("completed")
    expect(state.steps[0]?.status).toBe("completed")
    expect(state.steps[0]?.attempts).toBe(2)
  })

  test("queues user instructions and resumes an interrupted active task safely", async () => {
    const root = await workspace()
    const statePath = join(root, ".nexus", "task.json")
    const first = new MasterAgent({ workspace: root, statePath })
    await first.create("Inspect a web app")
    await first.plan([{ id: "browser", kind: "browser", title: "Inspect page", dependsOn: [] }])
    await first.enqueueInstruction("Also check the mobile layout")
    await first.transition("running")

    const second = new MasterAgent({ workspace: root, statePath })
    const recovered = await second.resume()
    expect(recovered?.status).toBe("paused")
    expect(recovered?.queuedInstructions).toEqual(["Also check the mobile layout"])
    expect(recovered?.objective).toBe("Inspect a web app")
  })

  test("verification is required by default even without the explicit flag", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    await agent.create("Verify the implementation")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    const state = await agent.executeStep("test", async () => ({ summary: "tests probably passed" }))

    expect(state.status).toBe("blocked")
    expect(state.error).toContain("verification evidence")
  })

  test("executePlan auto-repairs a blocked step and completes the follow-ups", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root })
    await agent.create("Fix and test the project")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    const seen: string[] = []
    const result = await agent.executePlan(async (request) => {
      seen.push(request.step.id)
      if (request.step.id === "test") {
        return { status: "blocked" as const, summary: "tests failed on main" }
      }
      return { summary: `repaired ${request.step.id}`, verification: [`${request.step.id} evidence recorded`] }
    })

    expect(seen).toEqual(["test", "test-repair", "test-verify"])
    expect(result.status).toBe("completed")
    expect(result.steps.find((step) => step.id === "test")?.status).toBe("blocked")
    expect(result.steps.find((step) => step.id === "test-repair")?.status).toBe("completed")
    expect(result.steps.find((step) => step.id === "test-verify")?.status).toBe("completed")
  })

  test("auto-repair stays bounded when every step keeps blocking", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root, maxAutoRepairs: 2 })
    await agent.create("Fix the unfixable")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    const result = await agent.executePlan(async () => ({
      status: "blocked" as const,
      summary: "still blocked",
    }))

    expect(result.status).toBe("blocked")
    expect(result.steps).toHaveLength(5)
  })

  test("auto-repair can be disabled to preserve fail-fast behavior", async () => {
    const root = await workspace()
    const agent = new MasterAgent({ workspace: root, autoRepair: false })
    await agent.create("Fix and test the project")
    await agent.plan([{ id: "test", kind: "tester", title: "Run tests", dependsOn: [] }])

    const result = await agent.executePlan(async () => ({
      status: "blocked" as const,
      summary: "tests failed on main",
    }))

    expect(result.status).toBe("blocked")
    expect(result.steps).toHaveLength(1)
  })
})
