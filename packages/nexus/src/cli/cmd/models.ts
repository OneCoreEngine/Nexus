import { EOL } from "os"
import { Effect, Exit } from "effect"
import { ModelsDev } from "@nexus-ai/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@nexus-ai/core/provider"

import { cmd } from "./cmd"
import * as Prompt from "../effect/prompt"
import { Config } from "@/config/config"
import { isTextGenerationCandidate, modelForProvider } from "@/provider/rotation"
import { getDeviceConfig } from "@nexus-ai/core/device"
import { formatLocalModelCatalog, formatLocalModelDetail, formatLocalModelRecommendations } from "./local-models"

function failureSummary(error: unknown): string {
  const message = String(error)
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout|network|transport/i.test(message))
    return "Network/DNS unavailable"
  if (
    /401|403|unauthorized|forbidden|invalid.*(?:api.?key|credential)|api.?key.*(?:not valid|invalid)|authentication/i.test(
      message,
    )
  )
    return "Authentication failed"
  if (/429|rate.?limit|too many requests|quota exceeded|freeusagelimit/i.test(message))
    return "Rate limited/quota exhausted"
  if (/404|model.*(?:not found|does not exist)|not found.*model|unsupported model/i.test(message))
    return "Model unavailable"
  if (/5\d\d|server error|service unavailable/i.test(message)) return "Provider server error"
  return "Request failed"
}

function normalizeConfiguredProvider(providerID: string): string {
  return providerID.toLowerCase() === "gemini" ? "google" : providerID.toLowerCase()
}

function configuredModelIDs(cfg: Record<string, any>, providerID: string): string[] {
  const normalized = normalizeConfiguredProvider(providerID)
  const providerConfig =
    cfg.provider?.[providerID] ??
    cfg.provider?.[normalized] ??
    (normalized === "google" ? cfg.provider?.gemini : undefined)
  const models = providerConfig?.models
  if (!models || typeof models !== "object" || Array.isArray(models)) return []
  return Object.keys(models)
    .map((id) => (id.includes("/") && id.split("/")[0] === normalized ? id.slice(normalized.length + 1) : id))
    .filter((id) => id.length > 0)
}

function configuredModelTarget(cfg: Record<string, any>): Array<{ providerID: string; modelID: string }> {
  const targets: Array<{ providerID: string; modelID: string }> = []
  for (const providerID of Object.keys(cfg.provider ?? {})) {
    for (const modelID of configuredModelIDs(cfg, providerID)) {
      targets.push({ providerID: normalizeConfiguredProvider(providerID), modelID })
    }
  }
  if (typeof cfg.model === "string" && cfg.model.includes("/")) {
    const [providerID, ...parts] = cfg.model.split("/")
    if (parts.length > 0)
      targets.unshift({ providerID: normalizeConfiguredProvider(providerID), modelID: parts.join("/") })
  }
  return targets
}

export const ModelsListCommand = effectCmd({
  command: "list [provider]",
  aliases: ["ls", "$0"],
  describe: "list all available models",
  instance: true,
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models.list")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => {
      const aIsNexus = a.startsWith("nexus")
      const bIsNexus = b.startsWith("nexus")
      if (aIsNexus && !bIsNexus) return -1
      if (!aIsNexus && bIsNexus) return 1
      return a.localeCompare(b)
    })

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})

export const ModelsTestCommand = effectCmd({
  command: "test",
  describe: "test configured models to see which ones work",
  instance: true,
  handler: Effect.fn("Cli.models.test")(function* () {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const s = yield* Provider.Service
    const cfgSvc = yield* Config.Service
    const cfg = yield* cfgSvc.get()

    UI.empty()
    yield* Prompt.intro("Testing configured models")

    const configured = Object.keys(cfg.provider ?? {})
    const configuredTargets = configuredModelTarget(cfg)
    if (configured.length === 0 && configuredTargets.length === 0) {
      yield* Prompt.log.warn("No custom providers or models configured.")
    }

    const testPrompt = "Reply with exactly OK"
    const providersToTest = Array.from(
      new Set([
        "groq",
        "openrouter",
        "google",
        "ollama",
        "openai",
        ...configured,
        ...configuredTargets.map((item) => item.providerID),
      ]),
    )
    const tested = new Set<string>()

    for (const pid of providersToTest) {
      if (tested.has(pid)) continue
      tested.add(pid)

      const provider = yield* s.getProvider(ProviderV2.ID.make(pid))
      if (!provider) continue
      // Do not issue requests for cloud providers that have no configured key.
      // Keyless providers are the intentional exception: ollama (local).
      if (pid !== "ollama" && (yield* s.rotationKeyCount(ProviderV2.ID.make(pid))) === 0 && !provider.key) continue

      const configuredIDs = configuredModelIDs(cfg, pid)
      const targets =
        configuredIDs.length > 0
          ? configuredIDs
              .map((modelID) => provider.models[modelID])
              .filter((item): item is NonNullable<typeof item> => Boolean(item))
          : []
      const preferredID = modelForProvider(pid, provider.models)
      const fallbackModel = preferredID
        ? provider.models[preferredID]
        : Provider.sort(
            Object.values(provider.models).filter((item) => isTextGenerationCandidate(pid, item.id, item)),
          )[0]
      const models = targets.length > 0 ? targets : fallbackModel ? [fallbackModel] : []
      for (const model of models) {
        if (!isTextGenerationCandidate(pid, model.id, model)) continue
        const modelKey = `${pid}/${model.id}`
        if (tested.has(modelKey)) continue
        tested.add(modelKey)
        const label = modelKey
        const spinner = Prompt.spinner()
        yield* spinner.start(`Testing ${label}...`)

        const language = yield* s.getLanguage(model).pipe(Effect.exit)
        if (Exit.isFailure(language)) {
          const errStr = String(language.cause)
          const summary = failureSummary(errStr)
          yield* spinner.stop(
            (summary === "Rate limited/quota exhausted"
              ? UI.Style.TEXT_WARNING_BOLD + "! "
              : UI.Style.TEXT_DANGER_BOLD + "✗ ") +
              UI.Style.TEXT_NORMAL +
              label +
              ` (${summary})` +
              (process.env.NEXUS_DEBUG_API === "1" ? ` ${errStr}` : ""),
          )
          continue
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            language.value.doGenerate({
              prompt: [{ role: "user", content: [{ type: "text", text: testPrompt }] }],
            }),
          catch: (e) => e,
        }).pipe(Effect.exit)
        if (Exit.isSuccess(result)) {
          yield* spinner.stop(UI.Style.TEXT_SUCCESS_BOLD + "✓ " + UI.Style.TEXT_NORMAL + label + " (Working)")
        } else {
          const errStr = String(result.cause)
          const summary = failureSummary(errStr)
          yield* spinner.stop(
            (summary === "Rate limited/quota exhausted"
              ? UI.Style.TEXT_WARNING_BOLD + "! "
              : UI.Style.TEXT_DANGER_BOLD + "✗ ") +
              UI.Style.TEXT_NORMAL +
              label +
              ` (${summary})` +
              (process.env.NEXUS_DEBUG_API === "1" ? ` ${errStr}` : ""),
          )
        }
      }
    }

    yield* Prompt.outro("Test complete")
  }),
})

export const ModelsLocalCommand = cmd({
  command: "local",
  describe: "show conservative local-model recommendations; this never downloads or runs a model",
  builder: (yargs) =>
    yargs
      .option("catalog", { type: "boolean", default: false, describe: "show the full local model catalog" })
      .option("model", { type: "string", describe: "show one catalog model by exact ID" })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  handler(args) {
    const config = getDeviceConfig()
    const format = args.format ?? "table"
    if (args.model) {
      process.stdout.write(formatLocalModelDetail(config, args.model, format === "json" ? "json" : "table") + EOL)
      return
    }
    if (args.catalog) {
      process.stdout.write(formatLocalModelCatalog(config, format === "json" ? "json" : "table") + EOL)
      return
    }
    if (format === "json") {
      process.stdout.write(
        JSON.stringify(
          {
            recommendations: formatLocalModelRecommendations(config),
            downloadsStarted: false,
            runtimeStarted: false,
          },
          null,
          2,
        ) + EOL,
      )
      return
    }
    process.stdout.write(formatLocalModelRecommendations(config).join(EOL) + EOL)
  },
})

export const ModelsCommand = cmd({
  command: "models",
  describe: "manage available models",
  builder: (yargs) =>
    yargs.command(ModelsListCommand).command(ModelsTestCommand).command(ModelsLocalCommand).demandCommand(),
  async handler() {},
})
