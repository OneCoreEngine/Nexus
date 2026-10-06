import fs from "fs"
import os from "os"
import path from "path"
import { PROVIDER_CONTRACTS, REGISTRY_PROVIDER_IDS, contractFor, type ProviderContract } from "./providers"

export const API_PROVIDERS = REGISTRY_PROVIDER_IDS

const PROVIDER_ALIASES: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_CONTRACTS).flatMap((contract) =>
    (contract.aliases ?? []).map((alias) => [alias, contract.id]),
  ),
)
export type ApiProvider = (typeof API_PROVIDERS)[number]
export type ApiKeyStatus = "active" | "rate_limited" | "invalid" | "suspended" | "unknown"

export type ApiKeySource = "ui" | "auth" | "cli"

export interface ApiKeyEntry {
  key: string
  label: string
  added: string
  status: ApiKeyStatus
  failures: number
  source?: ApiKeySource
  suspendedUntil?: string
  lastChecked?: string
  cooldownUntil?: string
  lastFailure?: "rate_limited" | "invalid" | "unknown"
  lastLatencyMs?: number
  /** Provider-specific non-secret metadata; it is not returned in public vault rows. */
  metadata?: Record<string, string>
}

export interface ProviderUsage {
  todayRequests: number
  todayInputTokens: number
  todayOutputTokens: number
  lastUsed?: string
}

/** Local NEXUS limits; never an asserted provider quota, balance, or price. */
export interface ApiUsageBudget {
  version: 1
  maxRequestsPerTask?: number
  maxTokensPerTask?: number
  maxRequestsPerDay?: number
  maxTokensPerDay?: number
}

export type ApiUsageBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: "task_request_cap" | "task_token_cap" | "daily_request_cap" | "daily_token_cap" }

export interface ApiVaultData {
  providers: Record<string, ApiKeyEntry[]>
  usage: Record<string, ProviderUsage>
  usageBudget: ApiUsageBudget
  autoRotate: boolean
  fallbackToLocal: boolean
}

const home = () => process.env.HOME || os.homedir()
export const apiVaultPath = () => path.join(home(), ".nexus", "api-vault.json")
export const apiUsagePath = () => path.join(home(), ".nexus", "api-usage.json")

function emptyVault(): ApiVaultData {
  return { providers: {}, usage: {}, usageBudget: { version: 1 }, autoRotate: true, fallbackToLocal: true }
}

function parseObject(source: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(source)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function positiveWhole(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : undefined
}

function normalizeUsageBudget(value: unknown): ApiUsageBudget {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const maxRequestsPerTask = positiveWhole(item.maxRequestsPerTask)
  const maxTokensPerTask = positiveWhole(item.maxTokensPerTask)
  const maxRequestsPerDay = positiveWhole(item.maxRequestsPerDay)
  const maxTokensPerDay = positiveWhole(item.maxTokensPerDay)
  return {
    version: 1,
    ...(maxRequestsPerTask ? { maxRequestsPerTask } : {}),
    ...(maxTokensPerTask ? { maxTokensPerTask } : {}),
    ...(maxRequestsPerDay ? { maxRequestsPerDay } : {}),
    ...(maxTokensPerDay ? { maxTokensPerDay } : {}),
  }
}

function storedMetadata(providerInput: string, value: unknown): Record<string, string> | undefined {
  const contract = contractFor(providerInput)
  if (!contract?.metadata?.length || !value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const metadata: Record<string, string> = {}
  for (const field of contract.metadata) {
    const candidate = raw[field.key]
    if (typeof candidate === "string" && candidate.trim()) metadata[field.key] = candidate.trim()
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function validatedMetadata(providerInput: string, value?: Record<string, string>): Record<string, string> | undefined {
  const contract = contractFor(providerInput)
  if (!contract?.metadata?.length) return undefined
  const metadata = storedMetadata(providerInput, value)
  for (const field of contract.metadata) {
    const candidate = metadata?.[field.key]
    if (field.required && !candidate) throw new Error(`${field.label} is required for ${contract.label}`)
    if (field.key === "accountId" && candidate && !/^[a-f0-9]{32}$/i.test(candidate)) {
      throw new Error("Cloudflare Account ID must be a 32-character hexadecimal value")
    }
  }
  return metadata
}

function normalizeEntry(value: unknown, provider: string): ApiKeyEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (typeof item.key !== "string" || !item.key.trim()) return undefined
  const status = item.status
  const validStatus: ApiKeyStatus =
    status === "active" || status === "rate_limited" || status === "invalid" || status === "suspended"
      ? status
      : "unknown"
  const source = item.source === "ui" || item.source === "auth" || item.source === "cli" ? item.source : undefined
  return {
    key: item.key.trim(),
    label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : "default",
    added: typeof item.added === "string" ? item.added : new Date().toISOString().slice(0, 10),
    status: validStatus,
    failures: typeof item.failures === "number" && Number.isFinite(item.failures) ? item.failures : 0,
    ...(source ? { source } : {}),
    ...(typeof item.suspendedUntil === "string" ? { suspendedUntil: item.suspendedUntil } : {}),
    ...(typeof item.lastChecked === "string" ? { lastChecked: item.lastChecked } : {}),
    ...(typeof item.cooldownUntil === "string" ? { cooldownUntil: item.cooldownUntil } : {}),
    ...(item.lastFailure === "rate_limited" || item.lastFailure === "invalid" || item.lastFailure === "unknown"
      ? { lastFailure: item.lastFailure }
      : {}),
    ...(typeof item.lastLatencyMs === "number" && Number.isFinite(item.lastLatencyMs) && item.lastLatencyMs >= 0
      ? { lastLatencyMs: Math.round(item.lastLatencyMs) }
      : {}),
    ...(storedMetadata(provider, item.metadata) ? { metadata: storedMetadata(provider, item.metadata) } : {}),
  }
}

function normalizeVault(value: Record<string, unknown>): ApiVaultData {
  const providers: Record<string, ApiKeyEntry[]> = {}
  const rawProviders =
    value.providers && typeof value.providers === "object" ? (value.providers as Record<string, unknown>) : {}
  for (const [provider, entries] of Object.entries(rawProviders)) {
    if (!Array.isArray(entries)) continue
    providers[provider.toLowerCase()] = entries
      .map((entry) => normalizeEntry(entry, provider.toLowerCase()))
      .filter((entry): entry is ApiKeyEntry => Boolean(entry))
  }
  const usage: Record<string, ProviderUsage> = {}
  const rawUsage = value.usage && typeof value.usage === "object" ? (value.usage as Record<string, unknown>) : {}
  for (const [provider, raw] of Object.entries(rawUsage)) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
    usage[provider.toLowerCase()] = {
      todayRequests:
        typeof item.todayRequests === "number"
          ? item.todayRequests
          : typeof item.today_requests === "number"
            ? item.today_requests
            : 0,
      todayInputTokens: typeof item.todayInputTokens === "number" ? item.todayInputTokens : 0,
      todayOutputTokens: typeof item.todayOutputTokens === "number" ? item.todayOutputTokens : 0,
      ...(typeof item.lastUsed === "string" ? { lastUsed: item.lastUsed } : {}),
    }
  }
  return {
    providers,
    usage,
    usageBudget: normalizeUsageBudget(value.usageBudget),
    autoRotate: value.autoRotate !== false,
    fallbackToLocal: value.fallbackToLocal !== false,
  }
}

export function loadApiVault(): ApiVaultData {
  const file = apiVaultPath()
  if (!fs.existsSync(file)) return emptyVault()
  return normalizeVault(parseObject(fs.readFileSync(file, "utf8")))
}

export function saveApiVault(vault: ApiVaultData): void {
  const file = apiVaultPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Termux filesystems may not implement chmod; the file is still private by default.
  }
  saveUsage(vault.usage)
  invalidateCachedVaultStatus()
}

export function saveUsage(usage: Record<string, ProviderUsage>): void {
  const file = apiUsagePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort only.
  }
}

export function normalizeProvider(provider: string): ApiProvider | undefined {
  const raw = provider
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
  const normalized = PROVIDER_ALIASES[raw] ?? raw
  if (normalized === "google") return "gemini"
  return (API_PROVIDERS as readonly string[]).includes(normalized) ? (normalized as ApiProvider) : undefined
}

export function maskApiKey(key: string): string {
  const value = key.trim()
  if (value.length <= 8) return "********"
  return `${value.slice(0, Math.min(7, value.length - 3))}***${value.slice(-3)}`
}

export function ensureApiKey(
  providerInput: string,
  key: string,
  label = "auth",
  metadata?: Record<string, string>,
): ApiKeyEntry | undefined {
  const provider = normalizeProvider(providerInput)
  const value = key.trim()
  if (!provider || !value) return undefined
  let validMetadata: Record<string, string> | undefined
  try {
    validMetadata = validatedMetadata(provider, metadata)
  } catch {
    return undefined
  }
  const vault = loadApiVault()
  const entries = vault.providers[provider] ?? []
  const existing = entries.find((entry) => entry.key === value)
  if (existing) {
    if (validMetadata) existing.metadata = validMetadata
    saveApiVault(vault)
    return existing
  }
  const entry: ApiKeyEntry = {
    key: value,
    label: label.trim() || "auth",
    added: new Date().toISOString().slice(0, 10),
    status: "unknown",
    failures: 0,
    source: "auth",
    ...(validMetadata ? { metadata: validMetadata } : {}),
  }
  vault.providers[provider] = [entry]
  saveApiVault(vault)
  return entry
}

export function addApiKey(
  providerInput: string,
  key: string,
  label = "default",
  source: ApiKeySource = "cli",
  metadata?: Record<string, string>,
): ApiKeyEntry {
  const provider = normalizeProvider(providerInput)
  if (!provider) throw new Error(`Unsupported provider: ${providerInput}. Supported: ${API_PROVIDERS.join(", ")}`)
  if (!key.trim()) throw new Error("API key cannot be empty")
  const validMetadata = validatedMetadata(provider, metadata)
  const vault = loadApiVault()
  const entries = vault.providers[provider] ?? []
  const existing = entries.find((entry) => entry.key === key.trim())
  if (existing) {
    existing.label = label.trim() || existing.label
    existing.source ??= source
    existing.status = "active"
    existing.failures = 0
    if (validMetadata) existing.metadata = validMetadata
    saveApiVault(vault)
    return existing
  }
  const entry: ApiKeyEntry = {
    key: key.trim(),
    label: label.trim() || "default",
    added: new Date().toISOString().slice(0, 10),
    status: "active",
    failures: 0,
    source,
    ...(validMetadata ? { metadata: validMetadata } : {}),
  }
  // Single-key policy: one model = one API per provider. Adding a key replaces
  // any previous key so rotation never cycles; user switches manually on exhaust.
  vault.providers[provider] = [entry]
  saveApiVault(vault)
  return entry
}

export function removeManagedApiKey(providerInput: string, key: string): boolean {
  const provider = normalizeProvider(providerInput)
  if (!provider) return false
  const vault = loadApiVault()
  const entries = vault.providers[provider] ?? []
  const value = key.trim()
  const index = entries.findIndex(
    (entry) =>
      entry.key === value &&
      (entry.source === "ui" || entry.source === "auth" || entry.label === "ui" || entry.label === "auth"),
  )
  if (index < 0) return false
  vault.providers[provider] = entries.filter((_, position) => position !== index)
  if (vault.providers[provider].length === 0) delete vault.providers[provider]
  saveApiVault(vault)
  return true
}

export function removeApiKey(providerInput: string, index: number): ApiKeyEntry {
  const provider = normalizeProvider(providerInput)
  if (!provider) throw new Error(`Unsupported provider: ${providerInput}`)
  if (!Number.isInteger(index) || index < 1) throw new Error("Key index must be a positive number")
  const vault = loadApiVault()
  const entries = vault.providers[provider] ?? []
  const removed = entries[index - 1]
  if (!removed) throw new Error(`No ${provider} key exists at index ${index}`)
  vault.providers[provider] = entries.filter((_, position) => position !== index - 1)
  if (vault.providers[provider].length === 0) delete vault.providers[provider]
  saveApiVault(vault)
  return removed
}

function invalidateCachedVaultStatus(): void {
  cachedVaultStatus = null
  lastVaultCacheTime = 0
}

export function updateApiKeyStatus(providerInput: string, key: string, status: ApiKeyStatus, error?: unknown): void {
  const provider = normalizeProvider(providerInput)
  if (!provider) return
  const vault = loadApiVault()
  const entry = (vault.providers[provider] ?? []).find((candidate) => candidate.key === key)
  if (!entry) {
    const previous = cachedConfiguredStatus[key]
    const failures = status === "active" ? 0 : (previous?.failures ?? 0) + 1
    cachedConfiguredStatus[key] = {
      key,
      label: previous?.label ?? "config",
      added: previous?.added ?? new Date().toISOString().slice(0, 10),
      status: failures >= 3 && status !== "active" ? "suspended" : status,
      failures,
      lastChecked: new Date().toISOString(),
      ...(status === "rate_limited" ? { cooldownUntil: cooldownUntil(failures) } : {}),
      ...(status === "rate_limited" || status === "invalid" || status === "unknown" ? { lastFailure: status } : {}),
      ...(failures >= 3 && status !== "active"
        ? { suspendedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
        : {}),
    }
    return
  }
  entry.status = status
  entry.lastChecked = new Date().toISOString()
  if (status === "active") {
    entry.failures = 0
    delete entry.suspendedUntil
    delete entry.cooldownUntil
    delete entry.lastFailure
  } else if (status === "rate_limited" || status === "invalid") {
    entry.failures += 1
    entry.lastFailure = status
    if (status === "rate_limited") entry.cooldownUntil = cooldownUntil(entry.failures)
    if (entry.failures >= 3) {
      entry.status = "suspended"
      entry.suspendedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }
  }
  void error
  saveApiVault(vault)
  invalidateCachedVaultStatus()
}

function cooldownUntil(failures: number): string {
  const minutes = Math.min(30, Math.max(5, 5 * Math.max(1, failures)))
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

/** Stores redacted, local health evidence only; it never persists provider responses or secret material. */
export function recordApiKeyLatency(providerInput: string, key: string, latencyMs: number): void {
  const provider = normalizeProvider(providerInput)
  if (!provider || !Number.isFinite(latencyMs) || latencyMs < 0) return
  const vault = loadApiVault()
  const entry = (vault.providers[provider] ?? []).find((candidate) => candidate.key === key)
  if (!entry) return
  entry.lastLatencyMs = Math.round(latencyMs)
  entry.lastChecked = new Date().toISOString()
  saveApiVault(vault)
  invalidateCachedVaultStatus()
}

export function recordApiUsage(
  providerInput: string,
  inputTokens: number,
  outputTokens: number,
  requestCount = 1,
): void {
  const provider = normalizeProvider(providerInput) ?? providerInput.toLowerCase()
  const vault = loadApiVault()
  const usage = vault.usage[provider] ?? { todayRequests: 0, todayInputTokens: 0, todayOutputTokens: 0 }
  usage.todayRequests += Math.max(1, Math.round(requestCount))
  usage.todayInputTokens += Math.max(0, Math.round(inputTokens))
  usage.todayOutputTokens += Math.max(0, Math.round(outputTokens))
  usage.lastUsed = new Date().toISOString()
  vault.usage[provider] = usage
  saveApiVault(vault)
}

/**
 * Preflights user-configured local caps against NEXUS-observed usage. Dispatchers
 * should stop before sending when this returns denied. It never guesses an account
 * balance, quota, or monetary cost.
 */
export function checkApiUsageBudget(input: {
  provider: string
  taskRequests?: number
  taskTokens?: number
  nextRequests?: number
  nextTokens?: number
}): ApiUsageBudgetDecision {
  const vault = loadApiVault()
  const budget = vault.usageBudget
  const taskRequests = Math.max(0, Math.round(input.taskRequests ?? 0))
  const taskTokens = Math.max(0, Math.round(input.taskTokens ?? 0))
  const nextRequests = Math.max(0, Math.round(input.nextRequests ?? 1))
  const nextTokens = Math.max(0, Math.round(input.nextTokens ?? 0))
  if (budget.maxRequestsPerTask !== undefined && taskRequests + nextRequests > budget.maxRequestsPerTask) {
    return { allowed: false, reason: "task_request_cap" }
  }
  if (budget.maxTokensPerTask !== undefined && taskTokens + nextTokens > budget.maxTokensPerTask) {
    return { allowed: false, reason: "task_token_cap" }
  }
  const provider = normalizeProvider(input.provider) ?? input.provider.toLowerCase()
  const usage = vault.usage[provider]
  const today = new Date().toISOString().slice(0, 10)
  const isToday = usage?.lastUsed?.slice(0, 10) === today
  const todayRequests = isToday ? (usage?.todayRequests ?? 0) : 0
  const todayTokens = isToday ? (usage?.todayInputTokens ?? 0) + (usage?.todayOutputTokens ?? 0) : 0
  if (budget.maxRequestsPerDay !== undefined && todayRequests + nextRequests > budget.maxRequestsPerDay) {
    return { allowed: false, reason: "daily_request_cap" }
  }
  if (budget.maxTokensPerDay !== undefined && todayTokens + nextTokens > budget.maxTokensPerDay) {
    return { allowed: false, reason: "daily_token_cap" }
  }
  return { allowed: true }
}

export function getApiUsageBudget(): ApiUsageBudget {
  return { ...loadApiVault().usageBudget }
}

/** A zero or omitted field clears that optional local cap. */
export function setApiUsageBudget(input: Partial<Omit<ApiUsageBudget, "version">>): ApiUsageBudget {
  const vault = loadApiVault()
  vault.usageBudget = normalizeUsageBudget({ ...vault.usageBudget, ...input })
  saveApiVault(vault)
  return { ...vault.usageBudget }
}

export function availableApiKeys(providerInput: string): ApiKeyEntry[] {
  const provider = normalizeProvider(providerInput)
  if (!provider) return []
  const now = Date.now()
  const vault = loadApiVault()
  const entries = vault.providers[provider] ?? []
  const healthyAvailable = entries.some((entry) => {
    if (entry.status === "invalid") return false
    if (entry.status === "suspended" && entry.suspendedUntil && Date.parse(entry.suspendedUntil) > now) return false
    return !entry.cooldownUntil || Date.parse(entry.cooldownUntil) <= now
  })
  return entries.filter((entry) => {
    if (entry.cooldownUntil && Date.parse(entry.cooldownUntil) > now && healthyAvailable) return false
    if (entry.status !== "suspended") return true
    return !entry.suspendedUntil || Date.parse(entry.suspendedUntil) <= now
  })
}

export function apiVaultRows(): Array<{
  provider: string
  index: number
  label: string
  key: string
  status: ApiKeyStatus
  usage: ProviderUsage
  cooldownUntil?: string
  lastFailure?: ApiKeyEntry["lastFailure"]
  lastLatencyMs?: number
}> {
  const vault = loadApiVault()
  return Object.entries(vault.providers).flatMap(([provider, entries]) =>
    entries.map((entry, index) => ({
      provider,
      index: index + 1,
      label: entry.label,
      key: maskApiKey(entry.key),
      status: entry.status,
      usage: vault.usage[provider] ?? { todayRequests: 0, todayInputTokens: 0, todayOutputTokens: 0 },
      ...(entry.cooldownUntil ? { cooldownUntil: entry.cooldownUntil } : {}),
      ...(entry.lastFailure ? { lastFailure: entry.lastFailure } : {}),
      ...(entry.lastLatencyMs !== undefined ? { lastLatencyMs: entry.lastLatencyMs } : {}),
    })),
  )
}

export function apiVaultPublicRows() {
  const vault = loadApiVault()
  return Object.entries(vault.providers).map(([provider, entries]) => ({
    provider,
    keys: entries.map((entry, index) => ({
      index: index + 1,
      label: entry.label,
      key: maskApiKey(entry.key),
      status: entry.status,
      failures: entry.failures,
      added: entry.added,
      ...(entry.lastChecked ? { lastChecked: entry.lastChecked } : {}),
      ...(entry.suspendedUntil ? { suspendedUntil: entry.suspendedUntil } : {}),
      ...(entry.cooldownUntil ? { cooldownUntil: entry.cooldownUntil } : {}),
      ...(entry.lastFailure ? { lastFailure: entry.lastFailure } : {}),
      ...(entry.lastLatencyMs !== undefined ? { lastLatencyMs: entry.lastLatencyMs } : {}),
      todayRequests: vault.usage[provider]?.todayRequests ?? 0,
      todayInputTokens: vault.usage[provider]?.todayInputTokens ?? 0,
      todayOutputTokens: vault.usage[provider]?.todayOutputTokens ?? 0,
    })),
  }))
}

const discoveredModelsCache = new Map<string, { expiresAt: number; models: string[] }>()

function modelNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  const root = value as Record<string, unknown>
  const isGemini = Array.isArray(root.models)
  const rows = (Array.isArray(root.data) ? root.data : isGemini ? root.models : []) as unknown[]
  return rows
    .map((item) => {
      if (typeof item === "string") return item
      if (!item || typeof item !== "object") return undefined
      const row = item as Record<string, unknown>
      if (
        isGemini &&
        Array.isArray(row.supportedGenerationMethods) &&
        !row.supportedGenerationMethods.includes("generateContent")
      )
        return undefined
      const name = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : undefined
      const normalized = name?.replace("models/", "")
      if (
        normalized &&
        /(?:tts|native-audio|audio|image|video|embedding|embed|speech|lyria|music|deep-research|computer-use|robotics|banana)/i.test(
          normalized,
        )
      ) {
        return undefined
      }
      return normalized
    })
    .filter((name): name is string => Boolean(name))
}

export async function discoverProviderModels(
  providerInput: string,
  key: string,
  metadata?: Record<string, string>,
): Promise<{ status: ApiKeyStatus; models: string[]; code?: number }> {
  const provider = normalizeProvider(providerInput)
  const contract = contractFor(providerInput)
  if (!provider || !contract) return { status: "unknown", models: [] }
  const cacheKey = `${provider}:${key}`
  const cached = discoveredModelsCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { status: "active", models: cached.models }
  if (contract.validation?.kind === "chat") {
    const checked = await checkKey(provider, key, metadata)
    if (checked.status !== "active") {
      return { status: checked.status, models: [], ...(checked.code ? { code: checked.code } : {}) }
    }
  }
  if (contract.validation?.kind === "cloudflare-run") {
    const checked = await checkKey(provider, key, metadata)
    if (checked.status !== "active") {
      return { status: checked.status, models: [], ...(checked.code ? { code: checked.code } : {}) }
    }
    const models = contract.curatedModels?.map((model) => model.id) ?? []
    discoveredModelsCache.set(cacheKey, { expiresAt: Date.now() + 2 * 60 * 1000, models })
    return { status: "active", models, ...(checked.code ? { code: checked.code } : {}) }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const headers = authHeadersFor(contract, key)
    const url =
      contract.auth === "query" ? `${contract.modelsEndpoint}?key=${encodeURIComponent(key)}` : contract.modelsEndpoint
    const response = await fetch(url, { headers, signal: controller.signal })
    const status =
      contract.validation?.kind === "chat" && response.ok
        ? "active"
        : validationStatusForResponse(contract, response.status)
    if (!response.ok) return { status, models: [], code: response.status }
    const models = modelNames(await response.json().catch(() => ({})))
    discoveredModelsCache.set(cacheKey, { expiresAt: Date.now() + 2 * 60 * 1000, models })
    return { status, models, code: response.status }
  } catch {
    return { status: "unknown", models: [] }
  } finally {
    clearTimeout(timer)
  }
}

export function apiVaultKeyEntries(): Array<{ provider: string; entry: ApiKeyEntry }> {
  const vault = loadApiVault()
  return Object.entries(vault.providers).flatMap(([provider, entries]) => entries.map((entry) => ({ provider, entry })))
}

/** Returns non-secret metadata only for an exact local key; public vault rows never include it. */
export function apiVaultMetadataForKey(providerInput: string, key: string): Record<string, string> | undefined {
  const provider = normalizeProvider(providerInput)
  if (!provider || !key.trim()) return undefined
  const entry = (loadApiVault().providers[provider] ?? []).find((candidate) => candidate.key === key.trim())
  return entry?.metadata ? { ...entry.metadata } : undefined
}

export function setAutoRotation(enabled: boolean): void {
  const vault = loadApiVault()
  vault.autoRotate = enabled
  saveApiVault(vault)
}

export function getApiVaultStatus(): Pick<ApiVaultData, "autoRotate" | "fallbackToLocal"> {
  const vault = loadApiVault()
  return { autoRotate: vault.autoRotate, fallbackToLocal: vault.fallbackToLocal }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function apiVaultKeyPath(): string {
  return apiVaultPath()
}

export function apiVaultHasKeys(providerInput?: string): boolean {
  if (providerInput) return availableApiKeys(providerInput).length > 0
  return apiVaultKeyEntries().length > 0
}

function endpointFor(providerInput: string): string | undefined {
  return contractFor(providerInput)?.modelsEndpoint
}

function authHeadersFor(contract: ProviderContract, key: string): Record<string, string> {
  if (contract.auth === "query") return {}
  if (contract.auth === "x-api-key") return { "x-api-key": key, ...(contract.headers ?? {}) }
  return { Authorization: `Bearer ${key}`, ...(contract.headers ?? {}) }
}

export async function checkKey(
  providerInput: string,
  key: string,
  metadata?: Record<string, string>,
): Promise<{ status: ApiKeyStatus; code?: number; latencyMs?: number }> {
  const provider = normalizeProvider(providerInput)
  const contract = contractFor(providerInput)
  if (!provider || !contract) return { status: "unknown" }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  const startedAt = Date.now()
  try {
    if (contract.validation?.kind === "chat") {
      const response = await fetch(`${contract.baseURL}/chat/completions`, {
        method: "POST",
        headers: { ...authHeadersFor(contract, key), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: contract.validation.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 1,
        }),
        signal: controller.signal,
      })
      return {
        status: validationStatusForResponse(contract, response.status),
        code: response.status,
        latencyMs: Date.now() - startedAt,
      }
    }
    if (contract.validation?.kind === "cloudflare-run") {
      const accountId = metadata?.accountId
      if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) return { status: "unknown" }
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${encodeURIComponent(contract.validation.model)}`,
        {
          method: "POST",
          headers: { ...authHeadersFor(contract, key), "Content-Type": "application/json" },
          body: JSON.stringify(contract.validation.payload),
          signal: controller.signal,
        },
      )
      const latencyMs = Date.now() - startedAt
      if (!response.ok)
        return { status: validationStatusForResponse(contract, response.status), code: response.status, latencyMs }
      const payload = (await response.json().catch(() => undefined)) as { success?: unknown } | undefined
      return { status: payload?.success === false ? "unknown" : "active", code: response.status, latencyMs }
    }
    const headers = authHeadersFor(contract, key)
    const url =
      contract.auth === "query" ? `${contract.modelsEndpoint}?key=${encodeURIComponent(key)}` : contract.modelsEndpoint
    const response = await fetch(url, { headers, signal: controller.signal })
    return {
      status: validationStatusForResponse(contract, response.status),
      code: response.status,
      latencyMs: Date.now() - startedAt,
    }
  } catch {
    return { status: "unknown" }
  } finally {
    clearTimeout(timer)
  }
}

export function validationStatusForResponse(contract: ProviderContract, status: number): ApiKeyStatus {
  if (contract.validation?.kind === "chat") {
    if (status >= 200 && status < 300) return "active"
    if (status === 400 || status === 401 || status === 403) return "invalid"
    if (status === 429) return "rate_limited"
    return "unknown"
  }
  if (contract.validation?.kind === "cloudflare-run") {
    if (status >= 200 && status < 300) return "active"
    if (status === 401 || status === 403) return "invalid"
    if (status === 429) return "rate_limited"
    return "unknown"
  }
  if (status >= 200 && status < 300) return contract.modelsEndpointPublic ? "unknown" : "active"
  if (status === 400 || status === 401 || status === 403) return "invalid"
  if (status === 429) return "rate_limited"
  return "unknown"
}

let cachedVaultStatus: Record<string, ApiKeyEntry> | null = null
let cachedConfiguredStatus: Record<string, ApiKeyEntry> = {}
let lastVaultCacheTime = 0

export function getCachedKeyStatus(key: string): ApiKeyEntry | undefined {
  const now = Date.now()
  if (!cachedVaultStatus || now - lastVaultCacheTime > 5000) {
    const vault = loadApiVault()
    const map: Record<string, ApiKeyEntry> = {}
    for (const entries of Object.values(vault.providers)) {
      for (const entry of entries) {
        map[entry.key] = entry
      }
    }
    cachedVaultStatus = map
    lastVaultCacheTime = now
  }
  return cachedVaultStatus[key] ?? cachedConfiguredStatus[key]
}

let verificationInProgress = false
export async function verifyAllVaultKeys(configured: Record<string, string[]> = {}): Promise<void> {
  if (verificationInProgress) return
  verificationInProgress = true
  try {
    const vault = loadApiVault()
    const vaultKeys = new Set(apiVaultKeyEntries().map(({ entry }) => entry.key))
    const tasks: Promise<void>[] = []
    for (const [prov, entries] of Object.entries(vault.providers)) {
      for (const entry of entries) {
        if (entry.status === "invalid") continue

        // Skip check if recently checked (within 5 minutes)
        if (entry.lastChecked && Date.now() - Date.parse(entry.lastChecked) < 5 * 60 * 1000) continue

        tasks.push(
          (async () => {
            const { status } = await checkKey(prov, entry.key, entry.metadata)
            if (status !== "unknown") updateApiKeyStatus(prov, entry.key, status)
          })(),
        )
      }
    }
    for (const [prov, keys] of Object.entries(configured)) {
      for (const key of keys) {
        if (typeof key !== "string" || !key.trim() || vaultKeys.has(key)) continue
        tasks.push(
          (async () => {
            const { status } = await checkKey(prov, key)
            if (status !== "unknown") {
              cachedConfiguredStatus[key] = {
                key,
                label: "config",
                added: new Date().toISOString().slice(0, 10),
                status,
                failures: 0,
                lastChecked: new Date().toISOString(),
              }
            }
          })(),
        )
      }
    }
    await Promise.all(tasks)
  } finally {
    verificationInProgress = false
  }
}

export function resetApiVaultForTests(): void {
  const file = apiVaultPath()
  if (fs.existsSync(file)) fs.unlinkSync(file)
  const usage = apiUsagePath()
  if (fs.existsSync(usage)) fs.unlinkSync(usage)
  cachedVaultStatus = null
  cachedConfiguredStatus = {}
  lastVaultCacheTime = 0
}

export { emptyVault }

export function resolveProviderLabel(provider: string): string {
  return contractFor(provider)?.label ?? provider
}
