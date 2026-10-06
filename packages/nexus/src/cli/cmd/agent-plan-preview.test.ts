import { describe, expect, test } from "bun:test"
import { createAgentPlanPreview, formatAgentPlanPreview } from "./agent-plan-preview"
import { createDeviceReadiness } from "./device"

const device = createDeviceReadiness({
  platform: "termux",
  architecture: "arm64",
  cpuCores: 8,
  totalMemoryBytes: 8 * 1024 ** 3,
  freeMemoryBytes: 2 * 1024 ** 3,
  storage: {},
  deviceGuard: { platform: "termux", level: "normal", network: "unknown", warnings: [] },
})

describe("agent plan preview", () => {
  test("returns explicit bounded role/device guidance without creating a run or task", () => {
    const preview = createAgentPlanPreview({ role: "reviewer", children: 1, parallel: 2, budget: "low", device })
    expect(preview).toMatchObject({
      role: { name: "reviewer", basePolicy: "review-only" },
      policy: { maxChildren: 1, maxParallel: 2, budgetClass: "low" },
      persistentRunCreated: false,
      agentStarted: false,
      taskDelegated: false,
    })
    expect(formatAgentPlanPreview(preview, "table")).toContain("preview only")
    expect(JSON.parse(formatAgentPlanPreview(preview, "json"))).toMatchObject({ persistentRunCreated: false })
  })

  test("rejects unsafe child and parallel policy requests", () => {
    expect(() => createAgentPlanPreview({ role: "planner", children: -1, parallel: 1, budget: "low", device })).toThrow(
      "children",
    )
    expect(() => createAgentPlanPreview({ role: "planner", children: 1, parallel: 3, budget: "low", device })).toThrow(
      "lead plus children",
    )
    expect(() =>
      createAgentPlanPreview({ role: "planner", children: 12, parallel: 13, budget: "low", device }),
    ).toThrow("parallel")
  })
})
