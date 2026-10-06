import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { Effect, Option } from "effect"
import { Process } from "@/util/process"
import { readNexusConfig, writeNexusConfig } from "./config"
import { PREFERRED_MODELS } from "@/provider/rotation"
import { inspectDeviceGuard, setupTermuxKeyboard } from "@nexus/termux-core"
import { arm64RecommendedModel } from "@nexus-ai/core/power"
import { largeDownloadWarning } from "@nexus-ai/core/network"
import { detectRuntimeEnvironment, type RuntimeEnvironment } from "@nexus-ai/core/platform"
import { createInterface } from "node:readline/promises"
import { stdin as setupInput, stdout as setupOutput } from "node:process"

async function confirmLargeDownload(message: string) {
  if (!setupInput.isTTY || !setupOutput.isTTY) {
    console.error(`${message} Re-run interactively to confirm.`)
    return false
  }
  const readline = createInterface({ input: setupInput, output: setupOutput })
  try {
    return (await readline.question(`${message} Continue? (y/N) `)).trim().toLowerCase().startsWith("y")
  } finally {
    readline.close()
  }
}

export type OllamaInstallPlan = { command?: string[]; message: string }

export const ollamaInstallPlan = (environment: RuntimeEnvironment): OllamaInstallPlan => {
  switch (environment) {
    case "termux":
      return {
        command: ["pkg", "install", "-y", "ollama"],
        message: "Installing Ollama with the native Termux package manager...",
      }
    case "macos":
      return { command: ["brew", "install", "ollama"], message: "Installing Ollama with Homebrew..." }
    case "windows":
      return { command: ["winget", "install", "Ollama.Ollama"], message: "Installing Ollama with winget..." }
    case "linux":
    case "wsl":
    case "proot":
    case "andronix":
    case "userland":
      return {
        message:
          "Ollama is not installed. Install it using your distribution's supported method, then rerun `nexus setup ollama`. NEXUS does not execute remote installer scripts automatically.",
      }
  }
}

function freeModelDefinitions(provider: keyof typeof PREFERRED_MODELS) {
  return Object.fromEntries(
    PREFERRED_MODELS[provider].map((id) => [
      id,
      {
        id,
        name: id,
        reasoning: false,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
      },
    ]),
  )
}

const PROVIDER_DEFINITIONS = {
  groq: {
    name: "Groq",
    api: "https://api.groq.com/openai/v1",
    npm: "@ai-sdk/groq",
    models: freeModelDefinitions("groq"),
  },
  openrouter: {
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    npm: "@openrouter/ai-sdk-provider",
    models: freeModelDefinitions("openrouter"),
  },
  google: {
    name: "Gemini",
    api: "https://generativelanguage.googleapis.com/v1beta",
    npm: "@ai-sdk/google",
    models: freeModelDefinitions("google"),
  },
} as const

type KeyProvider = keyof typeof PROVIDER_DEFINITIONS

function setupDebugEnabled() {
  return process.env.NEXUS_DEBUG_API === "1"
}

function setupSafeURL(url: string) {
  return url.replace(/([?&](?:key|api[_-]?key|token)=)[^&]+/gi, "$1<redacted>")
}

export function isChatModelID(id: string, provider: KeyProvider): boolean {
  const lower = id.toLowerCase()
  if (
    /(?:whisper|audio|speech|tts|image|vision|embedding|embed|moderation|rerank|guard|safety|transcription)/i.test(
      lower,
    )
  )
    return false
  if (provider === "groq") return /(?:llama|mixtral|gemma|qwen|deepseek)/i.test(lower)
  if (provider === "openrouter") return /(?:free|llama|mistral|gemma|qwen|deepseek|hermes|gpt)/i.test(lower)
  return /gemini-(?:3(?:\.\d+)?|2\.5|2\.0|1\.5)-(?:flash|pro)/i.test(id)
}

async function setupResponseOK(provider: string, response: Response, url: string) {
  console.log(`Response status: ${response.status}`)
  if (!response.ok) {
    if (setupDebugEnabled()) {
      const body = await response
        .clone()
        .text()
        .catch(() => "<unreadable response body>")
      console.error(
        `[NEXUS API] setup provider=${provider} status=${response.status} url=${setupSafeURL(url)} body=${body.slice(0, 2000)}`,
      )
    }
    console.error(`❌ Key invalid / network error (HTTP ${response.status})`)
  }
  return response.ok
}

async function validateKey(provider: KeyProvider, key: string): Promise<boolean> {
  const normalizedKey = typeof key === "string" ? key.trim() : ""
  if (!normalizedKey) return false

  // Never print even a key prefix: short prefixes are still useful for
  // correlating credentials across terminal logs and CI output.
  console.log(`Testing ${PROVIDER_DEFINITIONS[provider].name} API key...`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const headers = { Authorization: `Bearer ${normalizedKey}`, "Content-Type": "application/json" }
    if (provider === "groq" || provider === "openrouter") {
      const baseURL = provider === "groq" ? "https://api.groq.com/openai/v1" : "https://openrouter.ai/api/v1"
      const catalogURL = `${baseURL}/models`
      const catalogResponse = await fetch(catalogURL, { headers, signal: controller.signal })
      if (!(await setupResponseOK(provider, catalogResponse, catalogURL))) {
        return false
      }
      const catalog = (await catalogResponse.json().catch(() => ({ data: [] }))) as { data?: Array<{ id?: string }> }
      const ids = (catalog.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id))
      const preferred = PREFERRED_MODELS[provider]
      const FALLBACK = { groq: "openai/gpt-oss-120b", openrouter: "openai/gpt-oss-120b:free" } as const
      const safeFallback = provider === "groq" || provider === "openrouter" ? FALLBACK[provider] : undefined
      const model =
        preferred.find((id) => ids.includes(id)) ??
        ids.find(
          (id) => preferred.some((wanted) => id.startsWith(wanted.split(":")[0])) && isChatModelID(id, provider),
        ) ??
        (safeFallback && ids.includes(safeFallback) ? safeFallback : undefined) ??
        ids.find((id) => isChatModelID(id, provider))
      if (!model) {
        console.error(`❌ No compatible chat model found for validation in provider catalog.`)
        return false
      }
      const testURL = `${baseURL}/chat/completions`
      const testResponse = await fetch(testURL, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly OK" }], max_tokens: 8 }),
      })
      return setupResponseOK(provider, testResponse, testURL)
    }

    const catalogURL = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(normalizedKey)}`
    const catalogResponse = await fetch(catalogURL, { signal: controller.signal })
    if (!(await setupResponseOK(provider, catalogResponse, catalogURL))) return false
    const catalog = (await catalogResponse.json().catch(() => ({ models: [] }))) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
    }
    const ids = (catalog.models ?? [])
      .filter((item) => (item.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((item) => item.name?.replace(/^models\//, ""))
      .filter((id): id is string => Boolean(id))
    const preferred = PREFERRED_MODELS.google
    const model = preferred.find((id) => ids.includes(id)) ?? ids.find((id) => isChatModelID(id, provider))
    if (!model) {
      console.error(`❌ No compatible text-generation model found in the Gemini catalog.`)
      return false
    }
    const testURL = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(normalizedKey)}`
    const testResponse = await fetch(testURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with exactly OK" }] }] }),
    })
    return setupResponseOK(provider, testResponse, testURL)
  } catch (error) {
    if (setupDebugEnabled()) console.error(`[NEXUS API] setup fetch error provider=${provider} error=${String(error)}`)
    console.error(`❌ Key invalid / network error: ${String(error)}`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function appendUnique(existing: string[] | undefined, value: string): string[] {
  return Array.from(new Set([...(existing ?? []), value]))
}

function processExit(exited: Promise<number>) {
  return Effect.tryPromise({
    try: () => exited,
    catch: (error) => new CliError({ message: `Process failed: ${String(error)}` }),
  })
}

export const SetupOllamaCommand = effectCmd({
  command: "ollama",
  describe: "Install or configure Ollama, then pull a local model",
  instance: false,
  handler: Effect.fn("Cli.setup.ollama")(function* () {
    UI.empty()
    yield* Prompt.intro("Installing Ollama")

    const environment = detectRuntimeEnvironment()
    const existingProc = Process.spawn(["ollama", "--version"], { stdout: "ignore", stderr: "ignore" })
    const available = (yield* Effect.tryPromise(() => existingProc.exited).pipe(Effect.orElseSucceed(() => -1))) === 0
    if (!available) {
      const plan = ollamaInstallPlan(environment)
      if (!plan.command) return yield* fail(plan.message)
      yield* Prompt.log.info(plan.message)
      const installProc = Process.spawn(plan.command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
      const installCode = yield* processExit(installProc.exited)
      if (installCode !== 0) {
        return yield* fail(
          `Ollama could not be installed. ${plan.message} If the package manager is unavailable, install Ollama manually and rerun this command.`,
        )
      }
    }

    yield* Prompt.log.info("Starting Ollama service...")
    const serveProc = Process.spawn(["ollama", "serve"], { stdout: "ignore", stderr: "ignore" })
    void serveProc.exited

    const model = arm64RecommendedModel() ?? "llama3"
    const guard = inspectDeviceGuard()
    if (guard.level === "blocked") {
      return yield* fail(`Device Guard blocked this download: ${guard.warnings.join(" ")}`)
    }
    if (guard.warnings.length > 0) {
      const accepted = yield* Effect.tryPromise({
        try: () => confirmLargeDownload(`Device Guard warning: ${guard.warnings.join(" ")}`),
        catch: (error) => new CliError({ message: `Device Guard confirmation failed: ${String(error)}` }),
      })
      if (!accepted)
        return yield* fail(
          "Model download cancelled by Device Guard. Charge/cool the device or confirm interactively when ready.",
        )
    }
    const warning = yield* Effect.tryPromise({
      try: () => largeDownloadWarning(4 * 1024 * 1024 * 1024),
      catch: (error) => new CliError({ message: `Download warning check failed: ${String(error)}` }),
    })
    if (
      warning &&
      !(yield* Effect.tryPromise({
        try: () => confirmLargeDownload(warning),
        catch: (error) => new CliError({ message: `Download confirmation failed: ${String(error)}` }),
      }))
    ) {
      return yield* fail(
        "Model download cancelled. Connect to Wi-Fi or confirm the download interactively, then run `nexus setup ollama` again.",
      )
    }
    yield* Prompt.log.info(`Pulling ${model} (up to 4GB, ~10 mins on WiFi)...`)
    const pullProc = Process.spawn(["ollama", "pull", model], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const pullCode = yield* processExit(pullProc.exited)
    if (pullCode !== 0) return yield* fail("Ollama installed, but llama3 could not be pulled.")

    const { path: configPath, data: cfg } = readNexusConfig()
    cfg.model = `ollama/${model}`
    cfg.provider = {
      ...(cfg.provider ?? {}),
      ollama: {
        name: "Ollama",
        api: "http://127.0.0.1:11434/v1",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          [model]: {
            id: model,
            name: "Llama 3 (local)",
            reasoning: false,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
          },
          phi3: {
            id: "phi3",
            name: "Phi-3 (local)",
            reasoning: false,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
          },
          "qwen2.5-coder": {
            id: "qwen2.5-coder",
            name: "Qwen 2.5 Coder (local)",
            reasoning: false,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    }
    writeNexusConfig(configPath, cfg)

    yield* Prompt.log.success("✅ Ready! Using local model.")
    yield* Prompt.outro("Done")
  }),
})

export const SetupFreeCommand = effectCmd({
  command: "free",
  describe: "Configure and validate Groq, OpenRouter, and Gemini keys",
  instance: false,
  handler: Effect.fn("Cli.setup.free")(function* () {
    const { path: configPath, data: cfg } = readNexusConfig()
    const current = { ...(cfg.api_keys ?? {}) } as Record<string, string[]>
    const providers: KeyProvider[] = ["groq", "openrouter", "google"]
    const labels: Record<KeyProvider, string> = {
      groq: "Groq API key (free from groq.com)",
      openrouter: "OpenRouter key (free from openrouter.ai)",
      google: "Gemini key (free from aistudio.google.com)",
    }
    let valid = 0

    UI.empty()
    yield* Prompt.intro("NEXUS Free API Setup")

    for (const provider of providers) {
      const existing = current[provider] ?? current[provider === "google" ? "gemini" : provider] ?? []
      if (existing.length > 0) {
        const verified: string[] = []
        for (const key of existing) {
          const ok = yield* Effect.promise(() => validateKey(provider, key).catch(() => false))
          if (ok) verified.push(key)
        }
        current[provider === "google" ? "gemini" : provider] = verified
        if (verified.length > 0) {
          yield* Prompt.log.info(
            `${labels[provider]} verified (${verified.length} key${verified.length === 1 ? "" : "s"})`,
          )
          valid += verified.length
        } else {
          yield* Prompt.log.warn(
            `${labels[provider]} keys are invalid or unavailable; enter a new key to replace them.`,
          )
        }
      }

      if ((current[provider] ?? current[provider === "google" ? "gemini" : provider] ?? []).length > 0) continue

      const answer = yield* Prompt.password({ message: `${labels[provider]}:`, mask: "*" })
      if (Option.isNone(answer)) continue
      const key = typeof answer.value === "string" ? answer.value.trim() : ""
      if (!key) {
        yield* Prompt.log.warn(`${provider} key skipped: no key entered.`)
        continue
      }

      const ok = yield* Effect.promise(() => validateKey(provider, key).catch(() => false))
      if (!ok) {
        yield* Prompt.log.error(`${provider} key validation failed; it was not saved.`)
        continue
      }

      const storageName = provider === "google" ? "gemini" : provider
      current[storageName] = appendUnique(current[storageName], key)
      valid++
      yield* Prompt.log.success(`${provider} key validated.`)
    }

    const provider = {
      ...(cfg.provider ?? {}),
      groq: { ...(cfg.provider?.groq ?? {}), ...PROVIDER_DEFINITIONS.groq },
      openrouter: { ...(cfg.provider?.openrouter ?? {}), ...PROVIDER_DEFINITIONS.openrouter },
      google: { ...(cfg.provider?.google ?? {}), ...PROVIDER_DEFINITIONS.google },
    }
    cfg.api_keys = current
    cfg.rotation = true
    cfg.provider = provider

    const preferredProvider = (["groq", "openrouter", "google"] as const).find((id) => {
      const storageName = id === "google" ? "gemini" : id
      return (current[storageName] ?? []).length > 0
    })
    if (preferredProvider) {
      cfg.model = `${preferredProvider}/${PREFERRED_MODELS[preferredProvider][0]}`
    } else if (typeof cfg.model === "string" && /^(groq|openrouter|google)\//.test(cfg.model)) {
      delete cfg.model
    }
    writeNexusConfig(configPath, cfg)

    if (valid > 0) {
      yield* Prompt.log.success("✅ Ready. NEXUS ab directly chalega.")
    } else {
      yield* Prompt.log.error("❌ Koi key kaam nahi kar rahi. Ollama try karo: nexus setup ollama")
    }
    yield* Prompt.outro("Done")
  }),
})

export const SetupTermuxCommand = effectCmd({
  command: "termux",
  describe: "Configure Termux keyboard and clipboard-paste extra keys",
  instance: false,
  handler: Effect.fn("Cli.setup.termux")(function* () {
    const result = yield* Effect.tryPromise({
      try: () => setupTermuxKeyboard(),
      catch: (error) => new CliError({ message: String(error) }),
    })
    if (!result.configured) {
      yield* Prompt.log.warn(result.message)
      return
    }
    yield* Prompt.log.success("Termux keyboard configuration saved.")
    yield* Prompt.log.info(result.message)
  }),
})

export const SetupCommand = cmd({
  command: "setup",
  describe: "Setup providers and models",
  builder: (yargs) =>
    yargs.command(SetupOllamaCommand).command(SetupFreeCommand).command(SetupTermuxCommand).demandCommand(),
  async handler() {},
})
