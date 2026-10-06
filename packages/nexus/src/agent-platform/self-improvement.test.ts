import { classifyAdaptiveIntent } from "./adaptive-intent"
import {
  markProposalVerified,
  planAutonomousInternalUpgrade,
  proposalSummary,
  proposeIncidentRepair,
  proposeSelfImprovement,
} from "./self-improvement"
import type { AgentCapabilities } from "./capabilities"

const noBrowser: AgentCapabilities = {
  platform: "linux",
  architecture: "x64",
  termux: false,
  git: true,
  github: false,
  browserHandoff: false,
  browserHttpInspection: false,
  browserAutomation: false,
  webRuntime: true,
  android: false,
  androidDevice: false,
  apkBuild: false,
  packageManagers: ["bun"],
}

describe("controlled self-improvement", () => {
  test("creates a reviewable proposal for missing capabilities", () => {
    const intent = classifyAdaptiveIntent("Test the website login flow", noBrowser)
    const proposal = proposeSelfImprovement(intent)
    expect(proposal?.status).toBe("proposed")
    expect(proposal?.requiresApproval).toBe(true)
    expect(proposal?.activatesAutomatically).toBe(false)
    expect(proposal?.verification).toEqual(expect.arrayContaining([expect.stringMatching(/lint/i)]))
    expect(proposalSummary(proposal!)).toMatch(/approval required=true/i)
  })

  test("creates an approval-gated repair proposal from redacted incident evidence", () => {
    const report = {
      incidents: [
        {
          fingerprint: "abc123",
          severity: "error" as const,
          source: "worker" as const,
          message: "worker failed with api_key=[REDACTED]",
          timestamp: "2026-08-28T00:00:00.000Z",
        },
      ],
      truncated: false,
      bytesRead: 42,
      linesRead: 1,
      redactions: 1,
    }
    const proposal = proposeIncidentRepair(report)
    expect(proposal?.title).toContain("abc123")
    expect(proposal?.requiresApproval).toBe(true)
    expect(proposal?.activatesAutomatically).toBe(false)
    expect(proposal?.verification).toEqual(expect.arrayContaining([expect.stringMatching(/secrets/i)]))
  })

  test("does not propose upgrades when required capabilities exist", () => {
    const intent = classifyAdaptiveIntent("Fix a CLI bug", noBrowser)
    expect(proposeSelfImprovement(intent)).toBeUndefined()
  })

  test("auto-plans low-risk workspace upgrades only after verification", () => {
    const intent = classifyAdaptiveIntent("Test website buttons", noBrowser)
    const proposal = proposeSelfImprovement(intent)!
    const plan = planAutonomousInternalUpgrade({
      proposal,
      workspace: "/workspace/nexus",
      changedFiles: ["packages/nexus/src/adapter.ts"],
      actionSummary: "Add typed browser adapter and tests",
    })
    expect(plan.decision).toBe("auto_apply_after_tests")
    expect(plan.requiresApproval).toBe(false)
    expect(markProposalVerified(plan, true).status).toBe("verified")
  })

  test("cannot silently activate an unverified proposal", () => {
    const intent = classifyAdaptiveIntent("Test website buttons", noBrowser)
    const proposal = proposeSelfImprovement(intent)!
    expect(markProposalVerified(proposal, false).status).toBe("blocked")
    expect(markProposalVerified(proposal, true).status).toBe("verified")
    expect(markProposalVerified(proposal, true).activatesAutomatically).toBe(false)
    expect(
      planAutonomousInternalUpgrade({
        proposal,
        workspace: "/workspace/nexus",
        changedFiles: ["packages/nexus/src/adapter.ts"],
        actionSummary: "git push the new adapter",
      }).decision,
    ).toBe("awaiting_approval")
  })
})
