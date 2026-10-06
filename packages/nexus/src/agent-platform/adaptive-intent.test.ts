import { describe, expect, test } from "bun:test"
import { classifyAdaptiveIntent, createRequirementMemory, reviseRequirementMemory } from "./adaptive-intent"
import type { AgentCapabilities } from "./capabilities"

const capabilities: AgentCapabilities = {
  platform: "linux",
  architecture: "x64",
  termux: false,
  git: true,
  github: true,
  browserHandoff: true,
  browserHttpInspection: true,
  browserAutomation: false,
  webRuntime: true,
  android: true,
  androidDevice: false,
  apkBuild: true,
  packageManagers: ["bun"],
}

describe("adaptive intent", () => {
  test("derives coordinated web, browser, and bug-fix workers", () => {
    const intent = classifyAdaptiveIntent("Test my website buttons and fix broken login UI", capabilities)
    expect(intent.kind).toBe("web_testing")
    expect(intent.requestedWorkers).toEqual(expect.arrayContaining(["browser", "web", "coder", "reviewer", "tester"]))
    expect(intent.requiresUserTakeover).toBe(true)
    expect(intent.capabilityGaps).toEqual([])
  })

  test("reports capability gaps instead of claiming unsupported Android work", () => {
    const intent = classifyAdaptiveIntent("Build and test the APK on Android", { ...capabilities, android: false })
    expect(intent.kind).toBe("android_testing")
    expect(intent.capabilityGaps).toContain("Android tooling")
  })

  test("routes short uncomplicated requests to the fast tier", () => {
    const intent = classifyAdaptiveIntent("Fix a typo", capabilities)
    expect(intent.complexity).toBe("low")
    expect(intent.modelTier).toBe("fast")
    expect(intent.needsFreshKnowledge).toBe(false)
    expect(intent.confidence).toBeGreaterThan(0.5)
  })

  test("routes mixed or current-information requests to deep reasoning", () => {
    const intent = classifyAdaptiveIntent(
      "Research the latest secure architecture options, compare them, and refactor the production API",
      capabilities,
    )
    expect(intent.complexity).toBe("high")
    expect(intent.modelTier).toBe("deep")
    expect(intent.needsFreshKnowledge).toBe(true)
    expect(intent.confidence).toBeGreaterThan(0.7)
  })

  test("keeps revisions and constraints as safe requirement memory", () => {
    const memory = reviseRequirementMemory(
      createRequirementMemory("Improve this app"),
      "It must work on Termux and never store passwords; add UI testing",
    )
    expect(memory.revisions).toHaveLength(1)
    expect(memory.requirements[0]).toContain("must work")
    expect(memory.constraints[0]).toContain("Termux")
    expect(memory.objective).toContain("UI testing")
  })
})
