import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { classifyAdaptiveIntent } from "./adaptive-intent"
import {
  createCapabilityRegistry,
  loadCapabilityRegistry,
  missingVerifiedFeatures,
  saveCapabilityRegistry,
  upsertFeature,
} from "./capability-registry"
import type { AgentCapabilities } from "./capabilities"

const capabilities: AgentCapabilities = {
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
  packageManagers: ["bun"],
}

describe("capability registry", () => {
  test("persists feature records atomically and reloads them", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-capabilities-"))
    const path = join(root, ".nexus", "capabilities.json")
    let registry = createCapabilityRegistry()
    registry = upsertFeature(registry, {
      id: "browser-session",
      name: "Secure browser session",
      version: "1.0.0",
      status: "verified",
      summary: "User takeover and authenticated resume",
      files: ["agent-platform/browser-session.ts"],
      tests: ["browser-session.test.ts"],
      limitations: ["Requires an interactive browser adapter"],
      evidence: ["36 focused tests pass"],
    })
    await saveCapabilityRegistry(path, registry)
    const loaded = await loadCapabilityRegistry(path)
    expect(loaded.features[0]?.status).toBe("verified")
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1)
  })

  test("reports only missing worker capabilities not covered by verified features", () => {
    const intent = classifyAdaptiveIntent("Test the website login UI", capabilities)
    const registry = upsertFeature(createCapabilityRegistry(), {
      id: "browser-session",
      name: "browser session",
      version: "1.0.0",
      status: "verified",
      summary: "safe browser takeover",
      files: ["agent-platform/browser-session.ts"],
      tests: [],
      limitations: [],
    })
    expect(missingVerifiedFeatures(registry, intent)).not.toContain("browser")
  })

  test("recovers safely from a corrupt registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-capabilities-corrupt-"))
    const path = join(root, "capabilities.json")
    await writeFile(path, "not-json")
    expect((await loadCapabilityRegistry(path)).features).toEqual([])
  })
})
