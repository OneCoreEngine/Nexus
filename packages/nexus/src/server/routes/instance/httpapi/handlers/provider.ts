import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@nexus-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import {
  addApiKey,
  apiVaultKeyEntries,
  apiVaultPublicRows,
  discoverProviderModels,
  ensureApiKey,
  getCachedKeyStatus,
  loadApiVault,
  maskApiKey,
  normalizeProvider,
  removeApiKey,
  updateApiKeyStatus,
} from "@/api/ApiVault"
import { MODEL_MAP } from "@/api/ModelRouter"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError, ProviderVaultApiError } from "../groups/provider"
import { ProviderV2 } from "@nexus-ai/core/provider"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

function vaultError(error: unknown, providerID?: string) {
  const message = error instanceof Error ? error.message : String(error)
  const notFound = message.startsWith("No ")
  return new ProviderVaultApiError({
    name: notFound ? "NotFound" : "BadRequest",
    data: { ...(providerID ? { providerID } : {}), message },
  })
}

function publicEntry(entry: ReturnType<typeof addApiKey>, index = 1) {
  return {
    index,
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
    todayRequests: 0,
    todayInputTokens: 0,
    todayOutputTokens: 0,
  }
}

function logicalModelsFor(provider: string, model: string) {
  return Object.entries(MODEL_MAP)
    .filter(([, definition]) =>
      Object.entries(definition.providerModels).some(
        ([candidate, candidateModel]) => candidate === provider && candidateModel === model,
      ),
    )
    .map(([alias]) => alias)
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authStore = yield* Auth.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      const credentials = yield* authStore.all().pipe(Effect.orDie)
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      return {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
        connected: Object.keys(providers).filter((id) => id in connected || credentials[id]),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const keys = Effect.fn("ProviderHttpApi.keys")(function* () {
      const credentials = yield* authStore.all().pipe(Effect.orDie)
      const existing = new Set(apiVaultKeyEntries().map(({ provider, entry }) => `${provider}:${entry.key}`))
      for (const [providerID, credential] of Object.entries(credentials)) {
        if (credential.type !== "api") continue
        const normalized = normalizeProvider(providerID)
        if (!normalized || existing.has(`${normalized}:${credential.key}`)) continue
        const entry = ensureApiKey(normalized, credential.key, "auth", credential.metadata)
        if (entry) existing.add(`${normalized}:${entry.key}`)
      }
      const vault = loadApiVault()
      return { providers: apiVaultPublicRows(), autoRotate: vault.autoRotate }
    })

    const keysAdd = Effect.fn("ProviderHttpApi.keysAdd")(function* (ctx: {
      payload: { provider: string; key: string; label?: string; metadata?: { accountId?: string } }
    }) {
      let entry: ReturnType<typeof addApiKey>
      try {
        entry = addApiKey(
          ctx.payload.provider,
          ctx.payload.key,
          ctx.payload.label ?? "default",
          "ui",
          ctx.payload.metadata,
        )
      } catch (error) {
        return yield* Effect.fail(vaultError(error, ctx.payload.provider))
      }
      const normalized = normalizeProvider(ctx.payload.provider)
      if (normalized) {
        yield* authStore
          .set(
            normalized,
            new Auth.Api({ type: "api", key: entry.key, ...(entry.metadata ? { metadata: entry.metadata } : {}) }),
          )
          .pipe(Effect.orElseSucceed(() => undefined))
      }
      const providerID = normalized ?? ctx.payload.provider
      const index = apiVaultPublicRows()
        .find((item) => item.provider === providerID)
        ?.keys.findIndex((item) => item.key === maskApiKey(entry.key))
      return publicEntry(entry, index !== undefined && index >= 0 ? index + 1 : 1)
    })

    const keysRemove = Effect.fn("ProviderHttpApi.keysRemove")(function* (ctx: {
      params: { providerID: string; index: string }
    }) {
      const index = Number(ctx.params.index)
      let removed: ReturnType<typeof removeApiKey>
      try {
        removed = removeApiKey(ctx.params.providerID, index)
      } catch (error) {
        return yield* Effect.fail(vaultError(error, ctx.params.providerID))
      }
      const normalized = normalizeProvider(ctx.params.providerID)
      if (normalized) {
        const current = yield* authStore.get(ctx.params.providerID).pipe(Effect.orElseSucceed(() => undefined))
        if (current?.type === "api" && current.key === removed.key) {
          const replacement = apiVaultKeyEntries().find(
            (item) =>
              item.provider === normalized && (item.entry.status === "active" || item.entry.status === "unknown"),
          )
          if (replacement)
            yield* authStore
              .set(
                ctx.params.providerID,
                new Auth.Api({
                  type: "api",
                  key: replacement.entry.key,
                  ...(replacement.entry.metadata ? { metadata: replacement.entry.metadata } : {}),
                }),
              )
              .pipe(Effect.orElseSucceed(() => undefined))
          else yield* authStore.remove(ctx.params.providerID).pipe(Effect.orElseSucceed(() => undefined))
        }
      }
      return publicEntry(removed, index)
    })

    const modelsActive = Effect.fn("ProviderHttpApi.modelsActive")(function* () {
      const entries = apiVaultKeyEntries()
      const config = yield* cfg.get()
      const credentials = yield* authStore.all().pipe(Effect.orDie)
      const known = new Set(entries.map((item) => `${item.provider}:${item.entry.key}`))
      for (const [providerID, configuredKeys] of Object.entries(config.api_keys ?? {})) {
        const normalized = normalizeProvider(providerID)
        if (!normalized || !Array.isArray(configuredKeys)) continue
        for (const key of configuredKeys) {
          if (typeof key !== "string" || !key.trim() || known.has(`${normalized}:${key}`)) continue
          const cached = getCachedKeyStatus(key)
          entries.push({
            provider: normalized,
            entry: {
              key,
              label: "config",
              added: new Date().toISOString().slice(0, 10),
              status: cached?.status ?? "unknown",
              failures: cached?.failures ?? 0,
              ...(cached?.lastChecked ? { lastChecked: cached.lastChecked } : {}),
            },
          })
          known.add(`${normalized}:${key}`)
        }
      }
      for (const [providerID, credential] of Object.entries(credentials)) {
        if (credential.type !== "api") continue
        const normalized = normalizeProvider(providerID)
        if (!normalized || known.has(`${normalized}:${credential.key}`)) continue
        entries.push({
          provider: normalized,
          entry: {
            key: credential.key,
            label: "auth",
            added: new Date().toISOString().slice(0, 10),
            status: "unknown",
            failures: 0,
            ...(credential.metadata ? { metadata: credential.metadata } : {}),
          },
        })
      }
      const models = new Map<
        string,
        {
          provider: string
          model: string
          status: "active" | "rate_limited" | "invalid" | "suspended" | "unknown"
          logicalModels: string[]
        }
      >()
      const discoveries = yield* Effect.promise(() =>
        Promise.all(
          entries
            .filter(
              ({ entry }) =>
                entry.status !== "invalid" &&
                !(
                  entry.status === "suspended" &&
                  entry.suspendedUntil &&
                  Date.parse(entry.suspendedUntil) > Date.now()
                ),
            )
            .map(async ({ provider: providerID, entry }) => ({
              providerID,
              entry,
              discovered: await discoverProviderModels(providerID, entry.key, entry.metadata),
            })),
        ),
      )
      for (const { providerID, entry, discovered } of discoveries) {
        if (discovered.status === "invalid" || discovered.status === "rate_limited")
          updateApiKeyStatus(providerID, entry.key, discovered.status)
        for (const model of discovered.models) {
          const key = `${providerID}:${model}`
          const current = models.get(key)
          if (!current || current.status !== "active") {
            models.set(key, {
              provider: providerID,
              model,
              status: discovered.status,
              logicalModels: logicalModelsFor(providerID, model),
            })
          }
        }
      }
      return { models: [...models.values()], checkedAt: new Date().toISOString() }
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handle("keys", keys)
      .handle("keysAdd", keysAdd)
      .handle("keysRemove", keysRemove)
      .handle("modelsActive", modelsActive)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
