import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addApiKey,
  apiVaultPublicRows,
  checkKey,
  discoverProviderModels,
  resetApiVaultForTests,
} from "../../src/api/ApiVault"
import { PROVIDER_CONTRACTS, contractFor } from "../../src/api/providers"
import { withLocalFallbackCatalog } from "../../src/provider/provider"

const originalHome = process.env.HOME
const originalFetch = globalThis.fetch
const homes: string[] = []
const token = "nvidia-nim-test-token"

function installFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}

function useTemporaryHome() {
  const home = mkdtempSync(join(tmpdir(), "nexus-vault-nvidia-nim-"))
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

describe("hosted NVIDIA NIM API Vault contract", () => {
  test("uses a distinct hosted provider identity and key-only masked vault flow", () => {
    useTemporaryHome()

    const entry = addApiKey("nim", token, "hosted", "cli")
    const contract = PROVIDER_CONTRACTS["nvidia-nim"]

    expect(entry.key).toBe(token)
    expect(contractFor("nvidia-api")?.id).toBe("nvidia-nim")
    expect(contract.baseURL).toBe("https://integrate.api.nvidia.com/v1")
    expect(contract.modelsEndpoint).toBe("https://integrate.api.nvidia.com/v1/models")
    expect(contract.env).toEqual(["NVIDIA_NIM_API_KEY"])
    expect(JSON.stringify(apiVaultPublicRows())).not.toContain(token)
  })

  test("checks the hosted OpenAI-compatible models endpoint with bearer auth and maps rate limits", async () => {
    let request: Request | undefined
    installFetch(async (input, init) => {
      request = new Request(input, init)
      return Response.json({ data: [{ id: "meta/llama-3.3-70b-instruct" }] })
    })

    await expect(checkKey("nvidia-nim", token)).resolves.toMatchObject({ status: "active", code: 200 })
    expect(request?.method).toBe("GET")
    expect(request?.url).toBe("https://integrate.api.nvidia.com/v1/models")
    expect(request?.headers.get("Authorization")).toBe(`Bearer ${token}`)

    installFetch(async () => new Response("slow down", { status: 429 }))
    await expect(checkKey("nvidia-nim", token)).resolves.toMatchObject({ status: "rate_limited", code: 429 })
  })

  test("uses account-reported hosted models when available and a curated fallback capability catalog otherwise", async () => {
    installFetch(async () => Response.json({ data: [{ id: "meta/llama-3.3-70b-instruct" }] }))

    const discovered = await discoverProviderModels("nvidia-nim", token)
    const catalog = withLocalFallbackCatalog({}, { "nvidia-nim": [token] })

    expect(discovered).toMatchObject({ status: "active", models: ["meta/llama-3.3-70b-instruct"] })
    expect(catalog["nvidia-nim"]?.api).toBe("https://integrate.api.nvidia.com/v1")
    expect(catalog["nvidia-nim"]?.models["qwen/qwen2.5-coder-32b-instruct"]?.tool_call).toBe(false)
    expect(catalog["nvidia-nim"]?.models["qwen/qwen3-next-80b-a3b-thinking"]?.reasoning).toBe(true)
  })
})
