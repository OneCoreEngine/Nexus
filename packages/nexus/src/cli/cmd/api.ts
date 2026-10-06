import type { Argv } from "yargs"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import {
  API_PROVIDERS,
  apiVaultPublicRows,
  resolveProviderLabel,
  addApiKey as vaultAddApiKey,
  apiVaultKeyPath,
  apiVaultRows,
  getApiUsageBudget,
  getApiVaultStatus,
  maskApiKey,
  normalizeProvider,
  removeApiKey as vaultRemoveApiKey,
  recordApiKeyLatency,
  setAutoRotation,
  setApiUsageBudget,
  updateApiKeyStatus,
  type ApiKeyStatus,
} from "../../api/ApiVault"
import { routeModel } from "../../api/ModelRouter"

type ApiVaultRows = ReturnType<typeof apiVaultRows>
type PublicVaultRows = ReturnType<typeof apiVaultPublicRows>

export type ApiReadinessInput = {
  autoRotate: boolean
  budget: ReturnType<typeof getApiUsageBudget>
  rows: ApiVaultRows
  now?: number
}

export type ApiRoutePreviewInput = {
  model: string
  routes: ReturnType<typeof routeModel>
  rows: PublicVaultRows
  now?: number
}

function printError(error: unknown): void {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
}

import { checkKey } from "../../api/ApiVault"

type ApiVaultListInput = {
  vaultPath: string
  autoRotate: boolean
  budget: ReturnType<typeof getApiUsageBudget>
  rows: ReturnType<typeof apiVaultRows>
  now?: number
}

function isCooling(cooldownUntil: string | undefined, now: number): boolean {
  return Boolean(cooldownUntil && Date.parse(cooldownUntil) > now)
}

function providerUsageTotals(rows: ApiVaultRows) {
  const byProvider = new Map<string, { requests: number; tokens: number }>()
  for (const row of rows) {
    if (byProvider.has(row.provider)) continue
    byProvider.set(row.provider, {
      requests: row.usage.todayRequests,
      tokens: row.usage.todayInputTokens + row.usage.todayOutputTokens,
    })
  }
  return [...byProvider.values()].reduce(
    (total, usage) => ({ requests: total.requests + usage.requests, tokens: total.tokens + usage.tokens }),
    { requests: 0, tokens: 0 },
  )
}

/** Formats local prior-check evidence only; it deliberately does not perform a provider or key check. */
export function formatApiReadiness(input: ApiReadinessInput, format: "table" | "json" = "table"): string {
  const now = input.now ?? Date.now()
  const states = input.rows.reduce(
    (total, row) => {
      total[row.status]++
      if (isCooling(row.cooldownUntil, now)) total.cooling++
      return total
    },
    { active: 0, rate_limited: 0, invalid: 0, suspended: 0, unknown: 0, cooling: 0 },
  )
  const usage = providerUsageTotals(input.rows)
  const summary = {
    observedOnly: true as const,
    providers: new Set(input.rows.map((row) => row.provider)).size,
    keys: input.rows.length,
    states,
    autoRotate: input.autoRotate,
    localCaps: input.budget,
    observedToday: usage,
    limitations: [
      "Uses stored NEXUS local health and usage evidence only.",
      "Does not contact providers, test keys, change vault state, select a model, or start a task.",
      "Cannot report provider balance, remaining quota, account allocation, cost, or real-time availability.",
    ],
  }
  if (format === "json") return JSON.stringify(summary, null, 2)
  return [
    "API readiness (local observations only)",
    `Stored: ${summary.keys} masked key entries across ${summary.providers} provider(s); auto-rotation ${summary.autoRotate ? "on" : "off"}`,
    `Prior local status: ${states.active} active, ${states.unknown} unknown, ${states.rate_limited} rate-limited, ${states.invalid} invalid, ${states.suspended} suspended; ${states.cooling} cooling`,
    `NEXUS observed today: ${usage.requests} request(s) / ${usage.tokens} token(s) across stored providers`,
    `Local caps: task ${input.budget.maxRequestsPerTask ?? "off"} req / ${input.budget.maxTokensPerTask ?? "off"} tok; day ${input.budget.maxRequestsPerDay ?? "off"} req / ${input.budget.maxTokensPerDay ?? "off"} tok`,
    "No provider contacted, key checked, vault changed, route selected, or task started.",
    "This is not a provider balance, remaining quota, account allocation, cost, or real-time availability reading.",
  ].join("\n")
}

export function formatApiUsageBudget(budget: ReturnType<typeof getApiUsageBudget>): string {
  return [
    "Local caps (NEXUS-observed only):",
    `  Per task: ${budget.maxRequestsPerTask ?? "off"} requests; ${budget.maxTokensPerTask ?? "off"} tokens`,
    `  Per UTC day: ${budget.maxRequestsPerDay ?? "off"} requests; ${budget.maxTokensPerDay ?? "off"} tokens`,
    "  This is not a provider balance, remaining quota, or cost guarantee.",
  ].join("\n")
}

function routeEvidence(provider: string, rows: PublicVaultRows, now: number) {
  if (provider === "ollama") {
    return {
      kind: "local" as const,
      keyEntries: 0,
      active: 0,
      cooling: 0,
      summary: "Local candidate; backend/runtime availability is not checked.",
    }
  }
  const keys = rows.find((row) => row.provider === provider)?.keys ?? []
  const active = keys.filter((key) => key.status === "active").length
  const cooling = keys.filter((key) => isCooling(key.cooldownUntil, now)).length
  const summary = keys.length
    ? `Stored local evidence: ${active} active, ${cooling} cooling, ${keys.length} masked key entr${keys.length === 1 ? "y" : "ies"}.`
    : "No stored local key evidence."
  return { kind: "provider" as const, keyEntries: keys.length, active, cooling, summary }
}

/** Preview only: it preserves route ordering and does not select, validate, or dispatch any route. */
export function formatApiRoutePreview(input: ApiRoutePreviewInput, format: "table" | "json" = "table"): string {
  const now = input.now ?? Date.now()
  const candidates = input.routes.map((route, index) => ({
    position: index + 1,
    provider: route.provider,
    model: route.model,
    reason: route.reason,
    localEvidence: routeEvidence(route.provider, input.rows, now),
  }))
  const preview = {
    observedOnly: true as const,
    model: input.model,
    candidates,
    limitations: [
      "Preview only: preserves current candidate order but does not select a route or start a task.",
      "Does not contact providers, validate keys, mutate health/cooldown state, or expose raw keys.",
      "Local evidence is not provider balance, quota, cost, account access, or real-time availability.",
    ],
  }
  if (format === "json") return JSON.stringify(preview, null, 2)
  return [
    `Model preview: ${input.model}`,
    "#\tRoute\tReason\tLocal evidence",
    ...candidates.map(
      (candidate) =>
        `${candidate.position}\t${candidate.provider}/${candidate.model}\t${candidate.reason}\t${candidate.localEvidence.summary}`,
    ),
    "Preview only: no provider contacted, key validated, vault changed, route selected, or task started.",
    "Local evidence is not a provider balance, remaining quota, cost, account access, or real-time availability reading.",
  ].join("\n")
}

/** Formats masked local vault evidence; it intentionally cannot report upstream account state. */
export function formatApiVaultList(input: ApiVaultListInput): string {
  const now = input.now ?? Date.now()
  const lines = [
    `Vault: ${input.vaultPath}`,
    `Auto-rotation: ${input.autoRotate ? "on" : "off"}`,
    `Local caps: task ${input.budget.maxRequestsPerTask ?? "off"} req / ${input.budget.maxTokensPerTask ?? "off"} tok; day ${input.budget.maxRequestsPerDay ?? "off"} req / ${input.budget.maxTokensPerDay ?? "off"} tok (NEXUS-observed usage only)`,
  ]
  if (input.rows.length === 0) {
    lines.push("No API keys stored. Add one with: nexus api add <provider> <key> [label]")
    return lines.join("\n")
  }

  lines.push("Provider\t#\tLabel\tKey\tStatus\tHealth\tNEXUS observed today")
  for (const row of input.rows) {
    const cooling = row.cooldownUntil && Date.parse(row.cooldownUntil) > now
    const health =
      [
        cooling ? "cooldown" : undefined,
        row.lastFailure ? `last:${row.lastFailure}` : undefined,
        row.lastLatencyMs !== undefined ? `${row.lastLatencyMs}ms` : undefined,
      ]
        .filter(Boolean)
        .join(",") || "—"
    lines.push(
      `${row.provider}\t${row.index}\t${row.label}\t${row.key}\t${row.status}\t${health}\t${row.usage.todayRequests} req / ${row.usage.todayInputTokens + row.usage.todayOutputTokens} tok`,
    )
  }
  lines.push(
    "Usage shown is local NEXUS-observed activity only; it is not a provider balance, remaining quota, account token allocation, or cost reading.",
  )
  return lines.join("\n")
}

async function runWizard(): Promise<void> {
  prompts.intro("Add your API key")
  prompts.log.info("Har provider ke liye key paste karo — skip karne ke liye bas ENTER.")

  let saved = 0
  for (const provider of API_PROVIDERS) {
    const label = resolveProviderLabel(provider)
    if (provider === "nvidia-nim") {
      prompts.log.info(
        "NVIDIA NIM uses a hosted API key from build.nvidia.com. Model access and limits are account-specific.",
      )
    }
    const result = await prompts.password({
      message: `${label} API key (ENTER = skip)`,
    })
    if (prompts.isCancel(result) || !result || !result.trim()) continue
    try {
      const accountId =
        provider === "cloudflare-workers-ai"
          ? await prompts.text({
              message: "Cloudflare Account ID (required for Workers AI)",
              validate: (value) =>
                typeof value === "string" && /^[a-f0-9]{32}$/i.test(value.trim())
                  ? undefined
                  : "Enter the 32-character Account ID from Cloudflare",
            })
          : undefined
      if (prompts.isCancel(accountId)) continue
      vaultAddApiKey(
        provider,
        result.trim(),
        "default",
        "cli",
        provider === "cloudflare-workers-ai" ? { accountId: String(accountId).trim() } : undefined,
      )
      saved++
      prompts.log.success(`${label} saved (${maskApiKey(result.trim())})`)
    } catch (error) {
      prompts.log.warn(`${provider}: ${error instanceof Error ? error.message : "failed"}`)
    }
  }
  prompts.outro(saved > 0 ? `${saved} API key(s) vault mein stored` : "No keys added")
}

const AddCommand = cmd({
  command: "add [provider] [key] [label]",
  describe: "store an API key in the local NEXUS vault (no args = multi-provider wizard)",
  builder: (yargs: Argv) =>
    yargs
      .positional("provider", {
        describe:
          "provider id/alias (openai, anthropic, claude, gemini, groq, openrouter, cloudflare/workers-ai, nvidia-nim/nvidia-api/nim, xai/grok, deepseek, mistral, together, perplexity, cohere, fireworks, kimi, cerebras) — omit for wizard",
        type: "string",
      })
      .positional("key", { type: "string", describe: "API key" })
      .positional("label", { type: "string", describe: "optional label" })
      .option("account-id", { type: "string", describe: "required Cloudflare Account ID for cloudflare-workers-ai" }),
  async handler(args) {
    if (!args.provider) {
      await runWizard()
      return
    }
    if (!args.key) {
      printError(
        new Error(
          `Key required. Usage: nexus api add ${args.provider} <key> — or bare 'nexus api add' for the wizard.`,
        ),
      )
      process.exitCode = 1
      return
    }
    try {
      const provider = normalizeProvider(args.provider)
      const entry = vaultAddApiKey(
        args.provider,
        args.key,
        args.label,
        "cli",
        provider === "cloudflare-workers-ai" ? { accountId: args.accountId ?? "" } : undefined,
      )
      const label = resolveProviderLabel(provider ?? args.provider.toLowerCase())
      process.stdout.write(`✓ ${label} key saved (${entry.label})\n`)
      process.stdout.write(`  Vault: ${apiVaultKeyPath()}\n`)
      process.stdout.write(`  Stored: ${maskApiKey(entry.key)}\n`)
      if (provider === "nvidia-nim") {
        process.stdout.write(
          "  NVIDIA NIM: create or manage the API key at build.nvidia.com; model access and limits are account-specific.\n",
        )
      }
    } catch (error) {
      printError(error)
      process.exitCode = 1
    }
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "list stored API keys with masked values and status",
  builder: (yargs: Argv) => yargs,
  async handler() {
    const rows = apiVaultRows()
    const config = getApiVaultStatus()
    const budget = getApiUsageBudget()
    process.stdout.write(
      formatApiVaultList({ vaultPath: apiVaultKeyPath(), autoRotate: config.autoRotate, budget, rows }) + "\n",
    )
  },
})

const BudgetCommand = cmd({
  command: "budget",
  describe: "show or set local observed-usage caps; these are not provider quota or balance readings",
  builder: (yargs: Argv) =>
    yargs
      .option("task-requests", { type: "number", describe: "maximum local requests per task; 0 clears" })
      .option("task-tokens", { type: "number", describe: "maximum local input/output tokens per task; 0 clears" })
      .option("day-requests", { type: "number", describe: "maximum local requests per UTC day; 0 clears" })
      .option("day-tokens", { type: "number", describe: "maximum local input/output tokens per UTC day; 0 clears" }),
  async handler(args: { taskRequests?: number; taskTokens?: number; dayRequests?: number; dayTokens?: number }) {
    const hasChanges = [args.taskRequests, args.taskTokens, args.dayRequests, args.dayTokens].some(
      (value) => value !== undefined,
    )
    const budget = hasChanges
      ? setApiUsageBudget({
          ...(args.taskRequests !== undefined ? { maxRequestsPerTask: args.taskRequests } : {}),
          ...(args.taskTokens !== undefined ? { maxTokensPerTask: args.taskTokens } : {}),
          ...(args.dayRequests !== undefined ? { maxRequestsPerDay: args.dayRequests } : {}),
          ...(args.dayTokens !== undefined ? { maxTokensPerDay: args.dayTokens } : {}),
        })
      : getApiUsageBudget()
    process.stdout.write(formatApiUsageBudget(budget) + "\n")
  },
})

const CheckCommand = cmd({
  command: "check",
  describe: "test all stored API keys without printing secrets",
  builder: (yargs: Argv) => yargs,
  async handler() {
    const rows = apiVaultRows()
    if (rows.length === 0) {
      process.stdout.write("No API keys stored. Add one with: nexus api add <provider> <key> [label]\n")
      return
    }
    process.stdout.write("Checking API keys (secrets remain masked)...\n")
    for (const row of rows) {
      const vault = (await import("../../api/ApiVault")).loadApiVault()
      const rawEntry = vault.providers[row.provider]?.[row.index - 1]
      const rawKey = rawEntry?.key ?? ""
      const result = await checkKey(row.provider, rawKey, rawEntry?.metadata)
      const suffix = result.code ? ` HTTP ${result.code}` : ""
      process.stdout.write(
        `${result.status === "active" ? "✓" : result.status === "rate_limited" ? "!" : "✗"} ${row.provider} #${row.index} ${row.label} ${row.key} — ${result.status}${suffix}\n`,
      )
      if (rawKey) {
        updateApiKeyStatus(row.provider, rawKey, result.status, result)
        if (result.latencyMs !== undefined) recordApiKeyLatency(row.provider, rawKey, result.latencyMs)
      }
    }
  },
})

const RemoveCommand = cmd({
  command: "remove <provider> <index>",
  describe: "remove a key by provider and one-based index",
  builder: (yargs: Argv) => yargs.positional("index", { type: "number", describe: "one-based key index" }),
  async handler(args) {
    try {
      if (typeof args.provider !== "string" || typeof args.index !== "number")
        throw new Error("Provider and numeric index are required")
      const removed = vaultRemoveApiKey(args.provider, args.index)
      process.stdout.write(
        `✓ Removed ${args.provider.toLowerCase()} key #${args.index} (${removed.label}, ${maskApiKey(removed.key)})\n`,
      )
    } catch (error) {
      printError(error)
      process.exitCode = 1
    }
  },
})

const RotateCommand = cmd({
  command: "rotate <state>",
  describe: "turn automatic provider/key rotation on or off",
  builder: (yargs: Argv) => yargs.positional("state", { type: "string", choices: ["on", "off"] as const }),
  async handler(args) {
    setAutoRotation(args.state === "on")
    process.stdout.write(`✓ API rotation ${args.state}\n`)
  },
})

const RouteCommand = cmd({
  command: "route <model>",
  describe: "preview configured model candidates using stored local evidence only",
  builder: (yargs: Argv) =>
    yargs
      .option("format", { choices: ["table", "json"] as const, default: "table" })
      .option("tier", { choices: ["low", "medium", "high"] as const, describe: "Edge Router capability tier" }),
  async handler(args) {
    if (typeof args.model !== "string") throw new Error("Model is required")
    const tier = args.tier === "low" || args.tier === "medium" || args.tier === "high" ? args.tier : undefined
    const routes = routeModel(args.model, { tier })
    process.stdout.write(
      formatApiRoutePreview(
        { model: args.model, routes, rows: apiVaultPublicRows() },
        args.format === "json" ? "json" : "table",
      ) + "\n",
    )
  },
})

const ReadinessCommand = cmd({
  command: "readiness",
  describe: "summarize local vault health, cooldown, usage, and cap evidence without checking providers",
  builder: (yargs: Argv) => yargs.option("format", { choices: ["table", "json"] as const, default: "table" }),
  async handler(args) {
    const vault = getApiVaultStatus()
    process.stdout.write(
      formatApiReadiness(
        { autoRotate: vault.autoRotate, budget: getApiUsageBudget(), rows: apiVaultRows() },
        args.format === "json" ? "json" : "table",
      ) + "\n",
    )
  },
})

const WizardDefault = cmd({
  command: "$0",
  describe: "open the multi-provider API key wizard",
  builder: (yargs: Argv) => yargs,
  async handler() {
    await runWizard()
  },
})

export const ApiCommand = cmd({
  command: "api",
  describe: "manage API keys and smart model routing",
  builder: (yargs: Argv) =>
    yargs
      .command(WizardDefault)
      .command(AddCommand)
      .command(ListCommand)
      .command(BudgetCommand)
      .command(CheckCommand)
      .command(RemoveCommand)
      .command(RotateCommand)
      .command(RouteCommand)
      .command(ReadinessCommand),
  async handler() {},
})
