import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addApiKey,
  apiVaultMetadataForKey,
  apiVaultPublicRows,
  checkKey,
  discoverProviderModels,
  loadApiVault,
  resetApiVaultForTests,
} from "../../src/api/ApiVault"
import { PROVIDER_CONTRACTS } from "../../src/api/providers"
import { withLocalFallbackCatalog } from "../../src/provider/provider"

const originalHome = process.env.HOME
const originalFetch = globalThis.fetch
const homes: string[] = []
const accountId = "0123456789abcdef0123456789abcdef"
const token = "cloudflare-test-token"

function installFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}

function useTemporaryHome() {
  const home = mkdtempSync(join(tmpdir(), "nexus-vault-cloudflare-"))
  homes.push(home)
  process.env.HOME = home
  resetApiVaultForTests()
}

afterEach(() => {
  resetApiVaultForTests()
  process.env.HOME = originalHome
  globalThis.fetch = originalFetch
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe("Cloudflare Workers AI API Vault contract", () => {
  test("requires a valid local Account ID and never exposes it in public vault rows", () => {
    useTemporaryHome()

    expect(() => addApiKey("cloudflare-workers-ai", token)).toThrow("Cloudflare Account ID is required")
    expect(() => addApiKey("cloudflare-workers-ai", token, "default", "cli", { accountId: "bad" })).toThrow(
      "32-character hexadecimal",
    )

    addApiKey("cloudflare", token, "workers", "cli", { accountId })

    expect(loadApiVault().providers["cloudflare-workers-ai"]?.[0]?.metadata).toEqual({ accountId })
    expect(apiVaultMetadataForKey("cloudflare-workers-ai", token)).toEqual({ accountId })
    const publicRows = apiVaultPublicRows()
    expect(JSON.stringify(publicRows)).not.toContain(accountId)
    expect(JSON.stringify(publicRows)).not.toContain(token)
  })

  test("validates through the documented account-scoped Run endpoint and records no response body", async () => {
    let request: Request | undefined
    installFetch(async (input, init) => {
      request = new Request(input, init)
      return Response.json({ success: true, result: { response: "OK" } })
    })

    const result = await checkKey("cloudflare-workers-ai", token, { accountId })

    expect(result.status).toBe("active")
    expect(request?.method).toBe("POST")
    expect(request?.url).toContain(`/accounts/${accountId}/ai/run/`)
    expect(request?.headers.get("Authorization")).toBe(`Bearer ${token}`)
    expect(request?.headers.get("Content-Type")).toBe("application/json")
    expect(await request?.text()).toContain("Reply with OK.")
  })

  test("maps Run endpoint rate limits to cooldown-eligible vault status", async () => {
    installFetch(async () => new Response("slow down", { status: 429 }))
    await expect(checkKey("cloudflare-workers-ai", token, { accountId })).resolves.toMatchObject({
      status: "rate_limited",
      code: 429,
    })
  })

  test("uses an explicit curated model catalog with capability metadata instead of generic model discovery", async () => {
    installFetch(async () => Response.json({ success: true, result: { response: "OK" } }))
    const discovered = await discoverProviderModels("cloudflare-workers-ai", token, { accountId })
    const contract = PROVIDER_CONTRACTS["cloudflare-workers-ai"]
    const curatedModels = contract.curatedModels ?? []

    expect(discovered.status).toBe("active")
    expect(discovered.models).toEqual(curatedModels.map((model) => model.id))
    expect(contract.baseURL).toBe("https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1")
    expect(
      contract.curatedModels?.find((model) => model.id === "@cf/meta/llama-3.2-11b-vision-instruct")?.input,
    ).toContain("image")

    const catalog = withLocalFallbackCatalog({}, { "cloudflare-workers-ai": [token] })
    expect(catalog["cloudflare-workers-ai"]?.api).toBe(contract.baseURL)
    expect(catalog["cloudflare-workers-ai"]?.models["@cf/qwen/qwq-32b"]?.reasoning).toBe(true)
  })
})
