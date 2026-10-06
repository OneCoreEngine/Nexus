import { describe, expect, test } from "bun:test"
import { agentCapabilityStatus, formatAgentCapabilityStatus } from "./agent-status"
import type { AgentCapabilityStatusInput } from "./agent-status"

const input: AgentCapabilityStatusInput = {
  learning: [
    {
      id: "learning-1",
      runId: "run-1",
      title: "redacted",
      summary: "redacted",
      skillDraft: "secret draft",
      evidence: ["secret"],
      status: "proposed",
      createdAt: 1,
    },
    {
      id: "learning-2",
      runId: "run-2",
      title: "redacted",
      summary: "redacted",
      skillDraft: "secret draft",
      evidence: ["secret"],
      status: "approved",
      createdAt: 2,
    },
  ],
  skillRevisions: [
    {
      id: "skill-1",
      proposalId: "learning-2",
      title: "redacted",
      content: "secret revision",
      revision: 1,
      createdAt: 3,
    },
  ],
  schedules: [
    {
      id: "schedule-1",
      name: "redacted",
      expression: "0 9 * * *",
      timezone: "UTC",
      payload: "secret payload",
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "schedule-2",
      name: "redacted",
      expression: "0 10 * * *",
      timezone: "UTC",
      payload: "secret payload",
      enabled: true,
      createdAt: 2,
      updatedAt: 2,
    },
  ],
  runs: [
    {
      id: "run-1",
      mode: "interactive",
      status: "queued",
      policy: { maxChildren: 2, maxParallel: 3, budgetClass: "low" },
      requestedAt: 1,
    },
  ],
  gateways: [
    {
      id: "gateway-1",
      channel: "telegram",
      label: "private-label",
      runtimeMode: "local",
      credentialRef: "credential://telegram/private",
      allowedSenders: ["owner"],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "gateway-2",
      channel: "slack",
      label: "private-label",
      runtimeMode: "hosted",
      credentialRef: "credential://slack/private",
      allowedSenders: ["owner"],
      enabled: false,
      createdAt: 2,
      updatedAt: 2,
    },
  ],
  device: {
    platform: "termux",
    architecture: "arm64",
    cpuCores: 8,
    totalMemoryBytes: 8 * 1024 ** 3,
    freeMemoryBytes: 3 * 1024 ** 3,
    storage: {},
    deviceGuard: { platform: "termux", level: "normal", network: "unknown", warnings: [] },
    observedOnly: true,
  },
  localGatewayState: { version: 1, pid: 123, host: "127.0.0.1", port: 8787, startedAt: 1 },
}

describe("agent capability status", () => {
  test("summarizes the four local capabilities without exposing proposal, schedule, or gateway details", () => {
    const status = agentCapabilityStatus(input)
    expect(status.learning).toMatchObject({
      proposals: { proposed: 1, approved: 1 },
      approvedSkillRevisions: 1,
      explicitApprovalRequired: true,
    })
    expect(status.scheduler).toMatchObject({
      definitions: 2,
      enabledDefinitions: 1,
      disabledDefinitions: 1,
      workerStartedByInspection: false,
    })
    expect(status.subagents).toMatchObject({
      durablePlans: 1,
      policyBounds: { maxChildren: "0-12", maxParallel: "1-12" },
      agentStartedByInspection: false,
    })
    expect(status.gateway).toMatchObject({
      registeredConnections: 2,
      enabledConnections: 1,
      localProfiles: 1,
      hostedProfiles: 1,
      foregroundState: "recorded",
      listenerStartedByInspection: false,
    })
    const formatted = formatAgentCapabilityStatus(status, "table")
    for (const privateValue of [
      "secret draft",
      "secret revision",
      "secret payload",
      "private-label",
      "credential://",
      "owner",
      "gateway-1",
      "127.0.0.1",
      "8787",
    ]) {
      expect(formatted).not.toContain(privateValue)
    }
    expect(formatted).toContain("learning stays proposed until a user explicitly approves it")
    expect(formatted).toContain(
      "no credential, sender, connection ID, label, listener, remote connection, message, schedule execution, or token",
    )
  })

  test("has a stable JSON shape and reports no foreground gateway state when none is recorded", () => {
    const status = agentCapabilityStatus({ ...input, localGatewayState: undefined })
    const parsed = JSON.parse(formatAgentCapabilityStatus(status, "json"))
    expect(parsed.gateway.foregroundState).toBe("not-recorded")
    expect(parsed.subagents.roles.map((role: { name: string }) => role.name)).toEqual([
      "planner",
      "coder",
      "reviewer",
      "tester",
    ])
  })

  test("formats one requested capability section without including other sections or private metadata", () => {
    const formatted = formatAgentCapabilityStatus(agentCapabilityStatus(input), "table", "gateway")
    expect(formatted).toContain("Gateway readiness")
    expect(formatted).not.toContain("Learning records")
    expect(formatted).not.toContain("Subagent capacity")
    expect(formatted).not.toContain("private-label")
    expect(JSON.parse(formatAgentCapabilityStatus(agentCapabilityStatus(input), "json", "learning"))).toMatchObject({
      section: "learning",
      status: { explicitApprovalRequired: true },
    })
  })
})
