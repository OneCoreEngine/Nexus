import { createServer, type Server } from "node:http"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Global } from "@nexus-ai/core/global"
import { planGatewayRun, verifyDiscordInteraction, verifySlackRequest, verifyTelegramWebhook } from "./gateway"
import type { AgentPlatformStore, GatewayChannel } from "./store"

const MAX_BODY_BYTES = 256 * 1024

export type LocalGatewayState = {
  version: 1
  pid: number
  host: "127.0.0.1" | "::1"
  port: number
  startedAt: number
}

export type GatewayCredentialKind =
  | "telegram-bot-token"
  | "telegram-webhook-secret"
  | "slack-signing-secret"
  | "discord-public-key"

export function gatewayCredentialName(connectionId: string, kind: GatewayCredentialKind) {
  return `agent-gateway-${connectionId}-${kind}`
}

export function defaultLocalGatewayStatePath() {
  return join(Global.Path.data, "agent-gateway-local.json")
}

export function readLocalGatewayState(path = defaultLocalGatewayStatePath()): LocalGatewayState | undefined {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as LocalGatewayState
    if (state.version !== 1 || !Number.isInteger(state.pid) || !Number.isInteger(state.port)) return undefined
    return state
  } catch {
    return undefined
  }
}

function writeLocalGatewayState(state: LocalGatewayState, path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
  renameSync(temporary, path)
}

function removeLocalGatewayState(path: string) {
  rmSync(path, { force: true })
}

export function isLocalGatewayProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function clearLocalGatewayState(path = defaultLocalGatewayStatePath()) {
  removeLocalGatewayState(path)
}

function isLoopbackHost(host: string): host is LocalGatewayState["host"] {
  return host === "127.0.0.1" || host === "::1"
}

function eventFromTelegram(body: string) {
  const update = JSON.parse(body) as {
    update_id?: number
    message?: { from?: { id?: number | string }; chat?: { id?: number | string } }
  }
  if (update.update_id == null || update.message?.from?.id == null || update.message.chat?.id == null) return undefined
  return {
    eventId: String(update.update_id),
    senderId: String(update.message.from.id),
    conversationId: String(update.message.chat.id),
  }
}

function eventFromSlack(body: string) {
  const payload = JSON.parse(body) as { event_id?: string; event?: { user?: string; channel?: string } }
  if (!payload.event_id || !payload.event?.user || !payload.event.channel) return undefined
  return { eventId: payload.event_id, senderId: payload.event.user, conversationId: payload.event.channel }
}

function eventFromDiscord(body: string) {
  const payload = JSON.parse(body) as {
    id?: string
    channel_id?: string
    member?: { user?: { id?: string } }
    user?: { id?: string }
  }
  const senderId = payload.member?.user?.id ?? payload.user?.id
  if (!payload.id || !payload.channel_id || !senderId) return undefined
  return { eventId: payload.id, senderId, conversationId: payload.channel_id }
}

function json(response: import("node:http").ServerResponse, status: number, body: Record<string, unknown>) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  response.end(JSON.stringify(body))
}

async function readBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.length
    if (size > MAX_BODY_BYTES) throw new Error("Gateway request body exceeds 256 KiB")
    chunks.push(data)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function connectionFor(store: AgentPlatformStore, channel: GatewayChannel, id: string) {
  return store
    .listGatewayConnections()
    .find((connection) => connection.id === id && connection.channel === channel && connection.runtimeMode === "local")
}

export async function startLocalGatewayServer(input: {
  store: AgentPlatformStore
  credentialFor: (connectionId: string, kind: GatewayCredentialKind) => string | undefined
  host?: "127.0.0.1" | "::1"
  port?: number
  statePath?: string
}) {
  const host = input.host ?? "127.0.0.1"
  if (!isLoopbackHost(host)) throw new Error("Local gateway only permits loopback hosts")
  const statePath = input.statePath ?? defaultLocalGatewayStatePath()
  const existing = readLocalGatewayState(statePath)
  if (existing && isLocalGatewayProcessRunning(existing.pid))
    throw new Error(
      `A local gateway state file already exists for active pid ${existing.pid}; stop that foreground process first`,
    )
  if (existing) removeLocalGatewayState(statePath)
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" })
      const match = new URL(request.url ?? "/", "http://localhost").pathname.match(
        /^\/v1\/gateway\/(telegram|discord|slack)\/([0-9a-f-]{36})$/i,
      )
      if (!match) return json(response, 404, { error: "not_found" })
      const channel = match[1] as GatewayChannel
      const connectionId = match[2]!
      const connection = connectionFor(input.store, channel, connectionId)
      if (!connection || !connection.enabled) return json(response, 404, { error: "connection_not_enabled" })
      const rawBody = await readBody(request)
      const credential = input.credentialFor(
        connectionId,
        channel === "telegram"
          ? "telegram-webhook-secret"
          : channel === "slack"
            ? "slack-signing-secret"
            : "discord-public-key",
      )
      if (!credential) return json(response, 503, { error: "verification_material_not_configured" })

      const verified =
        channel === "telegram"
          ? verifyTelegramWebhook({
              expectedSecret: credential,
              receivedSecret: request.headers["x-telegram-bot-api-secret-token"] as string | undefined,
            })
          : channel === "slack"
            ? verifySlackRequest({
                signingSecret: credential,
                rawBody,
                timestamp: request.headers["x-slack-request-timestamp"] as string | undefined,
                signature: request.headers["x-slack-signature"] as string | undefined,
              })
            : verifyDiscordInteraction({
                publicKey: credential,
                rawBody,
                timestamp: request.headers["x-signature-timestamp"] as string | undefined,
                signature: request.headers["x-signature-ed25519"] as string | undefined,
              })
      if (!verified) return json(response, 401, { error: "invalid_signature" })

      if (channel === "discord" && (JSON.parse(rawBody) as { type?: number }).type === 1)
        return json(response, 200, { type: 1 })
      if (channel === "slack" && (JSON.parse(rawBody) as { type?: string }).type === "url_verification")
        return json(response, 200, { challenge: (JSON.parse(rawBody) as { challenge?: string }).challenge ?? "" })

      const event =
        channel === "telegram"
          ? eventFromTelegram(rawBody)
          : channel === "slack"
            ? eventFromSlack(rawBody)
            : eventFromDiscord(rawBody)
      if (!event) return json(response, 202, { accepted: false, reason: "unsupported_event" })
      const planned = planGatewayRun(input.store, { schemaVersion: 1, connectionId, ...event })
      return json(response, planned.reservation.accepted ? 202 : 200, {
        accepted: planned.reservation.accepted,
        reason: planned.reservation.reason,
        runId: planned.run?.id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "gateway_error"
      return json(response, message.includes("256 KiB") ? 413 : 400, {
        error: message.includes("256 KiB") ? "payload_too_large" : "invalid_request",
      })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port ?? 0, host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Local gateway did not expose a TCP address")
  const state: LocalGatewayState = { version: 1, pid: process.pid, host, port: address.port, startedAt: Date.now() }
  writeLocalGatewayState(state, statePath)
  return {
    state,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      removeLocalGatewayState(statePath)
    },
  }
}

export async function pollTelegramOnce(input: {
  token: string
  offset?: number
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  onUpdate: (update: { eventId: string; senderId: string; conversationId: string }) => void
}) {
  const fetchImpl = input.fetchImpl ?? fetch
  const url = new URL(`https://api.telegram.org/bot${input.token}/getUpdates`)
  url.searchParams.set("timeout", "25")
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]))
  if (input.offset != null) url.searchParams.set("offset", String(input.offset))
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Telegram polling failed with HTTP ${response.status}`)
  const payload = (await response.json()) as { ok?: boolean; description?: string; result?: unknown[] }
  if (!payload.ok || !Array.isArray(payload.result))
    throw new Error(`Telegram polling failed: ${payload.description ?? "unknown response"}`)
  let nextOffset = input.offset
  let accepted = 0
  for (const raw of payload.result) {
    const event = eventFromTelegram(JSON.stringify(raw))
    const updateId = (raw as { update_id?: number }).update_id
    if (updateId != null) nextOffset = Math.max(nextOffset ?? 0, updateId + 1)
    if (!event) continue
    input.onUpdate(event)
    accepted += 1
  }
  return { nextOffset, accepted }
}
