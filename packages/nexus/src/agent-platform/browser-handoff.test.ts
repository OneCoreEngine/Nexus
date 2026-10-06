import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  findSafeBrowserHandoffUrl,
  inspectPublicBrowserPage,
  openLocalBrowser,
  parseBrowserHandoffTarget,
} from "./browser-handoff"

describe("BrowserHandoff", () => {
  test("accepts HTTP(S) URLs and exposes only an audit-safe origin", () => {
    const target = parseBrowserHandoffTarget("https://console.example.test/project#fragment")
    expect(target.origin).toBe("https://console.example.test")
    expect(target.hasSensitiveQuery).toBe(false)
    expect(target.launchUrl).toBe("https://console.example.test/project#fragment")
  })

  test("rejects sensitive query parameters before launch", () => {
    expect(() => parseBrowserHandoffTarget("https://console.example.test/project?token=private-value")).toThrow(
      "sensitive query parameters",
    )
  })

  test("extracts only a safe HTTP(S) permission pattern", () => {
    expect(findSafeBrowserHandoffUrl(["/tmp/project", "https://portal.example.test/login"])).toBe(
      "https://portal.example.test/login",
    )
    expect(
      findSafeBrowserHandoffUrl(["https://portal.example.test/login?token=private-value", "/tmp/project"]),
    ).toBeUndefined()
  })

  test("rejects non-web URL schemes", () => {
    expect(() => parseBrowserHandoffTarget("file:///private/data")).toThrow("http:// or https://")
    expect(() => parseBrowserHandoffTarget("javascript:alert(1)")).toThrow("http:// or https://")
  })

  test("inspects a public HTML page with bounded text evidence", async () => {
    const result = await inspectPublicBrowserPage("https://example.test/page", {
      maxPreviewChars: 100,
      fetch: async () =>
        new Response("<html><title>Example page</title><script>secret()</script><p>Hello browser worker</p></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    })

    expect(result.status).toBe(200)
    expect(result.title).toBe("Example page")
    expect(result.textPreview).toBe("Example page Hello browser worker")
    expect(result.textPreview.length).toBeLessThanOrEqual(100)
  })

  test("refuses sensitive query parameters before performing a request", async () => {
    let called = false
    await expect(
      inspectPublicBrowserPage("https://example.test/page?api_key=private", {
        fetch: async () => {
          called = true
          return new Response("unexpected")
        },
      }),
    ).rejects.toThrow("sensitive query parameters")
    expect(called).toBe(false)
  })

  test("uses the local Termux opener with an origin-only URL", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-browser-handoff-"))
    const marker = join(root, "opened-url.txt")
    const opener = join(root, "termux-open-url")
    writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > "${marker}"\n`)
    chmodSync(opener, 0o755)
    const original = { termux: process.env.TERMUX_VERSION, path: process.env.PATH }
    try {
      process.env.TERMUX_VERSION = "1"
      process.env.PATH = `${root}:${original.path ?? ""}`
      await openLocalBrowser("https://portal.example.test/login", { termuxOpener: opener })
      expect(readFileSync(marker, "utf8")).toBe("https://portal.example.test/login")
    } finally {
      if (original.termux === undefined) delete process.env.TERMUX_VERSION
      else process.env.TERMUX_VERSION = original.termux
      if (original.path === undefined) delete process.env.PATH
      else process.env.PATH = original.path
      rmSync(root, { recursive: true, force: true })
    }
  })
})
