import { describe, expect, test } from "bun:test"
import { createIncidentWatcher } from "./incident-watcher"

describe("incident watcher", () => {
  test("uses a slower interval on Termux and emits redacted local reports", async () => {
    const reports: string[] = []
    const watcher = createIncidentWatcher({
      device: { platform: "android", termux: true, architecture: "arm64", adbConnected: false, nativeCapabilities: [] },
      onReport: (report) => {
        reports.push(report.incidents[0]?.message ?? "")
      },
    })
    expect(watcher.intervalMs).toBe(30_000)
    await watcher.ingest("[worker] api_key=private-token failed")
    expect(reports[0]).not.toContain("private-token")
  })

  test("only emits a developer report when consent is supplied", async () => {
    let count = 0
    const watcher = createIncidentWatcher({
      device: { platform: "linux", termux: false, architecture: "x64", adbConnected: false, nativeCapabilities: [] },
      onDeveloperReport: () => void count++,
    })
    await watcher.ingest("worker failed")
    expect(count).toBe(0)

    const optedIn = createIncidentWatcher({
      device: { platform: "linux", termux: false, architecture: "x64", adbConnected: false, nativeCapabilities: [] },
      developerReportConsent: {
        enabled: true,
        includeDeviceMetrics: false,
        includeIncidentFingerprints: true,
        includeVersion: false,
      },
      onDeveloperReport: () => void count++,
    })
    await optedIn.ingest("worker failed")
    expect(count).toBe(1)
  })

  test("ingests async process-output chunks without retaining secrets", async () => {
    const watcher = createIncidentWatcher({
      device: { platform: "android", termux: true, architecture: "arm64", adbConnected: false, nativeCapabilities: [] },
    })
    const chunks = (async function* () {
      yield "worker failed with api_key="
      yield new TextEncoder().encode("private-token")
    })()
    const report = await watcher.ingestStream(chunks)
    expect(report.incidents[0]?.message).not.toContain("private-token")
  })

  test("rejects ingestion after stop", async () => {
    const watcher = createIncidentWatcher({
      device: { platform: "linux", termux: false, architecture: "x64", adbConnected: false, nativeCapabilities: [] },
    })
    watcher.stop()
    expect(watcher.ingest("error")).rejects.toThrow(/stopped/i)
  })
})
