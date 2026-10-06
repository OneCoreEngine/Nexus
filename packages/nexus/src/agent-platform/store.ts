import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { Global } from "@nexus-ai/core/global"
import { redactSensitive } from "@nexus-ai/assistant/core/redact"

export const AGENT_PLATFORM_SCHEMA_VERSION = 4

export type MemoryScope = "device" | "project" | "channel"
export type MemoryKind = "fact" | "preference" | "decision" | "summary" | "instruction"
export type LearningStatus = "proposed" | "approved" | "rejected" | "superseded"
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted"

export type RunPolicy = {
  maxChildren: number
  maxParallel: number
  budgetClass: "low" | "standard" | "high"
}

export type AgentRun = {
  id: string
  parentRunId?: string
  mode: "interactive" | "scheduled" | "channel"
  status: RunStatus
  policy: RunPolicy
  idempotencyKey?: string
  requestedAt: number
  startedAt?: number
  completedAt?: number
}

export type MemoryRecord = {
  id: string
  scope: MemoryScope
  scopeId: string
  kind: MemoryKind
  content: string
  sourceRunId?: string
  confidence: number
  status: "active" | "superseded" | "deleted"
  createdAt: number
  updatedAt: number
}

export type LearningProposal = {
  id: string
  runId: string
  title: string
  summary: string
  skillDraft: string
  evidence: string[]
  status: LearningStatus
  createdAt: number
  reviewedAt?: number
}

export type SkillRevision = {
  id: string
  proposalId: string
  title: string
  content: string
  revision: number
  createdAt: number
}

export type MemorySyncPack = {
  schemaVersion: 1
  exportedAt: number
  scope: Exclude<MemoryScope, "device">
  scopeId: string
  records: Array<
    Pick<
      MemoryRecord,
      "scope" | "scopeId" | "kind" | "content" | "confidence" | "sourceRunId" | "createdAt" | "updatedAt"
    >
  >
}

export type AgentSchedule = {
  id: string
  name: string
  expression: string
  timezone: string
  payload: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type GatewayChannel = "telegram" | "discord" | "slack"
export type GatewayRuntimeMode = "local" | "hosted"
export type GatewayConnection = {
  id: string
  channel: GatewayChannel
  label: string
  runtimeMode: GatewayRuntimeMode
  credentialRef: string
  allowedSenders: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}
export type GatewayEventReservation = {
  accepted: boolean
  reason?: "connection_disabled" | "sender_not_allowed" | "duplicate"
  eventRecordId?: string
}
export type ScheduleExecutionClaim = {
  id: string
  scheduleId: string
  scheduledWindow: string
  claimed: boolean
  leaseExpiresAt?: number
}

export type BrowserHandoffStatus = "awaiting_user" | "resumed" | "completed_by_user" | "cancelled" | "expired"
export type BrowserHandoff = {
  id: string
  origin: string
  purpose: string
  status: BrowserHandoffStatus
  createdAt: number
  updatedAt: number
  resumedAt?: number
  completedAt?: number
}

type StoreOptions = { path?: string }

function now() {
  return Date.now()
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function asBoolean(value: unknown) {
  return Number(value) === 1
}

function decodeMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    scope: row.scope as MemoryScope,
    scopeId: String(row.scope_id),
    kind: row.kind as MemoryKind,
    content: String(row.content),
    sourceRunId: typeof row.source_run_id === "string" ? row.source_run_id : undefined,
    confidence: Number(row.confidence),
    status: row.status as MemoryRecord["status"],
    createdAt: Number(row.time_created),
    updatedAt: Number(row.time_updated),
  }
}

function decodeLearning(row: Record<string, unknown>): LearningProposal {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    title: String(row.title),
    summary: String(row.summary),
    skillDraft: String(row.skill_draft),
    evidence: JSON.parse(String(row.evidence_json)) as string[],
    status: row.status as LearningStatus,
    createdAt: Number(row.time_created),
    reviewedAt: row.time_reviewed == null ? undefined : Number(row.time_reviewed),
  }
}

function decodeSkillRevision(row: Record<string, unknown>): SkillRevision {
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    title: String(row.title),
    content: String(row.content),
    revision: Number(row.revision),
    createdAt: Number(row.time_created),
  }
}

function decodeRun(row: Record<string, unknown>): AgentRun {
  return {
    id: String(row.id),
    parentRunId: typeof row.parent_run_id === "string" ? row.parent_run_id : undefined,
    mode: row.mode as AgentRun["mode"],
    status: row.status as RunStatus,
    policy: JSON.parse(String(row.policy_json)) as RunPolicy,
    idempotencyKey: typeof row.idempotency_key === "string" ? row.idempotency_key : undefined,
    requestedAt: Number(row.time_requested),
    startedAt: row.time_started == null ? undefined : Number(row.time_started),
    completedAt: row.time_completed == null ? undefined : Number(row.time_completed),
  }
}

function decodeGatewayConnection(row: Record<string, unknown>): GatewayConnection {
  return {
    id: String(row.id),
    channel: row.channel as GatewayChannel,
    label: String(row.label),
    runtimeMode: row.runtime_mode as GatewayRuntimeMode,
    credentialRef: String(row.credential_ref),
    allowedSenders: JSON.parse(String(row.allowed_senders_json)) as string[],
    enabled: asBoolean(row.enabled),
    createdAt: Number(row.time_created),
    updatedAt: Number(row.time_updated),
  }
}

function decodeBrowserHandoff(row: Record<string, unknown>): BrowserHandoff {
  return {
    id: String(row.id),
    origin: String(row.origin),
    purpose: String(row.purpose),
    status: row.status as BrowserHandoffStatus,
    createdAt: Number(row.time_created),
    updatedAt: Number(row.time_updated),
    resumedAt: row.time_resumed == null ? undefined : Number(row.time_resumed),
    completedAt: row.time_completed == null ? undefined : Number(row.time_completed),
  }
}

function assertBrowserOrigin(value: string) {
  const parsed = new URL(value)
  if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== value)
    throw new Error("Browser handoff records require an HTTP(S) origin without a path, query, or fragment")
  return parsed.origin
}

function assertCredentialReference(value: string) {
  const ref = value.trim()
  if (!/^credential:\/\/[a-z0-9._/-]+$/i.test(ref)) {
    throw new Error("Gateway credentials must be an opaque credential:// reference, never a raw token")
  }
  return ref
}

export function defaultAgentPlatformPath() {
  return process.env.NEXUS_AGENT_DB || join(Global.Path.data, "agent-platform.db")
}

/**
 * Local-first durable storage for the agent foundation. It keeps its own
 * versioned SQLite file so agent-platform migrations cannot alter existing
 * session, account, or API-vault storage.
 */
export class AgentPlatformStore {
  readonly path: string
  private readonly db: Database

  constructor(options: StoreOptions = {}) {
    this.path = options.path ?? defaultAgentPlatformPath()
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new Database(this.path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    this.migrate()
  }

  close() {
    this.db.close()
  }

  private migrate() {
    const row = this.db.query("PRAGMA user_version").get() as { user_version?: number } | null
    const version = Number(row?.user_version ?? 0)
    if (version >= AGENT_PLATFORM_SCHEMA_VERSION) return
    if (version < 1)
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_run_id TEXT,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_active_unique
        ON agent_memory(scope, scope_id, content_hash) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS agent_memory_scope_updated ON agent_memory(scope, scope_id, time_updated DESC);

      CREATE TABLE IF NOT EXISTS agent_learning_proposal (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        skill_draft TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_reviewed INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_skill_revision (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES agent_learning_proposal(id),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        time_created INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_run (
        id TEXT PRIMARY KEY,
        parent_run_id TEXT REFERENCES agent_run(id),
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        idempotency_key TEXT,
        time_requested INTEGER NOT NULL,
        time_started INTEGER,
        time_completed INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_run_idempotency_unique
        ON agent_run(idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS agent_schedule (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        payload TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_audit (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        time_created INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `)
    if (version < 2)
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_adapter_connection (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        label TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        allowed_senders_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        UNIQUE(channel, label)
      );
      CREATE TABLE IF NOT EXISTS agent_gateway_event (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES agent_adapter_connection(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        dispatch_status TEXT NOT NULL,
        time_received INTEGER NOT NULL,
        UNIQUE(connection_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS agent_delivery (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES agent_adapter_connection(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_message_id TEXT,
        detail_json TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_schedule_execution (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES agent_schedule(id) ON DELETE CASCADE,
        scheduled_window TEXT NOT NULL,
        run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        UNIQUE(schedule_id, scheduled_window)
      );
      CREATE TABLE IF NOT EXISTS agent_memory_replica (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        cursor TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        UNIQUE(scope, scope_id, remote_id)
      );
      PRAGMA user_version = 2;
    `)
    if (version < 3)
      this.db.exec(`
      ALTER TABLE agent_adapter_connection ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'local';
      PRAGMA user_version = 3;
    `)
    if (version < 4)
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_browser_handoff (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        purpose TEXT NOT NULL,
        status TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_resumed INTEGER,
        time_completed INTEGER
      );
      CREATE INDEX IF NOT EXISTS agent_browser_handoff_updated ON agent_browser_handoff(time_updated DESC);
      PRAGMA user_version = 4;
    `)
  }

  addMemory(input: Omit<MemoryRecord, "id" | "content" | "createdAt" | "updatedAt" | "status"> & { content: string }) {
    const content = redactSensitive(input.content).trim()
    if (!content) throw new Error("Memory content is empty after redaction")
    const timestamp = now()
    const id = randomUUID()
    this.db
      .query(
        `INSERT INTO agent_memory (id, scope, scope_id, kind, content, content_hash, source_run_id, confidence, status, time_created, time_updated)
         VALUES ($id, $scope, $scopeId, $kind, $content, $contentHash, $sourceRunId, $confidence, 'active', $timestamp, $timestamp)
         ON CONFLICT DO UPDATE SET confidence = excluded.confidence, time_updated = excluded.time_updated`,
      )
      .run({
        $id: id,
        $scope: input.scope,
        $scopeId: input.scopeId,
        $kind: input.kind,
        $content: content,
        $contentHash: hash(content),
        $sourceRunId: input.sourceRunId ?? null,
        $confidence: Math.min(1, Math.max(0, input.confidence)),
        $timestamp: timestamp,
      })
    const stored = this.db
      .query("SELECT * FROM agent_memory WHERE scope = ? AND scope_id = ? AND content_hash = ? AND status = 'active'")
      .get(input.scope, input.scopeId, hash(content)) as Record<string, unknown>
    return decodeMemory(stored)
  }

  listMemory(scope?: MemoryScope, scopeId?: string) {
    const rows = scope
      ? this.db
          .query(
            "SELECT * FROM agent_memory WHERE scope = ? AND scope_id = ? AND status = 'active' ORDER BY time_updated DESC",
          )
          .all(scope, scopeId ?? "default")
      : this.db.query("SELECT * FROM agent_memory WHERE status = 'active' ORDER BY time_updated DESC").all()
    return (rows as Record<string, unknown>[]).map(decodeMemory)
  }

  searchMemory(query: string, scope: MemoryScope, scopeId: string) {
    const safeQuery = redactSensitive(query).trim().toLowerCase()
    if (!safeQuery) return []
    const rows = this.db
      .query(
        "SELECT * FROM agent_memory WHERE scope = ? AND scope_id = ? AND status = 'active' AND lower(content) LIKE ? ORDER BY confidence DESC, time_updated DESC LIMIT 20",
      )
      .all(scope, scopeId, `%${safeQuery}%`) as Record<string, unknown>[]
    return rows.map(decodeMemory)
  }

  deleteMemory(id: string) {
    const result = this.db
      .query("UPDATE agent_memory SET status = 'deleted', time_updated = ? WHERE id = ? AND status = 'active'")
      .run(now(), id)
    if (!result.changes) throw new Error(`Active memory not found: ${id}`)
    this.audit("memory.deleted", "memory", id, {})
  }

  replaceMemory(id: string, input: { content: string; confidence?: number }) {
    const current = this.db.query("SELECT * FROM agent_memory WHERE id = ? AND status = 'active'").get(id) as Record<
      string,
      unknown
    > | null
    if (!current) throw new Error(`Active memory not found: ${id}`)
    const memory = decodeMemory(current)
    this.db.query("UPDATE agent_memory SET status = 'superseded', time_updated = ? WHERE id = ?").run(now(), id)
    const replacement = this.addMemory({
      scope: memory.scope,
      scopeId: memory.scopeId,
      kind: memory.kind,
      content: input.content,
      sourceRunId: memory.sourceRunId,
      confidence: input.confidence ?? memory.confidence,
    })
    this.audit("memory.replaced", "memory", id, { replacementId: replacement.id })
    return replacement
  }

  exportMemorySyncPack(scope: Exclude<MemoryScope, "device">, scopeId: string): MemorySyncPack {
    const records = this.listMemory(scope, scopeId).map((memory) => ({
      scope: memory.scope,
      scopeId: memory.scopeId,
      kind: memory.kind,
      content: memory.content,
      confidence: memory.confidence,
      sourceRunId: memory.sourceRunId,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    }))
    const pack: MemorySyncPack = { schemaVersion: 1, exportedAt: now(), scope, scopeId, records }
    this.audit("memory.sync_exported", "memory_scope", `${scope}:${scopeId}`, { records: records.length })
    return pack
  }

  importMemorySyncPack(pack: MemorySyncPack) {
    if (pack.schemaVersion !== 1) throw new Error("Unsupported memory sync pack version")
    if ((pack.scope !== "project" && pack.scope !== "channel") || !pack.scopeId.trim())
      throw new Error("Memory sync packs may contain only selected project or channel scopes")
    if (!Array.isArray(pack.records)) throw new Error("Invalid memory sync pack records")
    const imported: MemoryRecord[] = []
    for (const item of pack.records) {
      if (item.scope !== pack.scope || item.scopeId !== pack.scopeId)
        throw new Error("Memory sync pack contains a mismatched scope")
      if (!["fact", "preference", "decision", "summary", "instruction"].includes(item.kind))
        throw new Error("Memory sync pack contains an unsupported memory kind")
      imported.push(
        this.addMemory({
          scope: item.scope,
          scopeId: item.scopeId,
          kind: item.kind,
          content: item.content,
          sourceRunId: item.sourceRunId,
          confidence: item.confidence,
        }),
      )
    }
    this.audit("memory.sync_imported", "memory_scope", `${pack.scope}:${pack.scopeId}`, {
      records: imported.length,
      exportedAt: pack.exportedAt,
    })
    return imported
  }

  proposeLearning(input: { runId: string; title: string; summary: string; skillDraft: string; evidence?: string[] }) {
    const proposal: LearningProposal = {
      id: randomUUID(),
      runId: input.runId,
      title: redactSensitive(input.title).trim(),
      summary: redactSensitive(input.summary).trim(),
      skillDraft: redactSensitive(input.skillDraft).trim(),
      evidence: (input.evidence ?? []).map(redactSensitive),
      status: "proposed",
      createdAt: now(),
    }
    if (!proposal.title || !proposal.skillDraft)
      throw new Error("Learning proposal requires a title and redacted skill draft")
    this.db
      .query(
        "INSERT INTO agent_learning_proposal (id, run_id, title, summary, skill_draft, evidence_json, status, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        proposal.id,
        proposal.runId,
        proposal.title,
        proposal.summary,
        proposal.skillDraft,
        JSON.stringify(proposal.evidence),
        proposal.status,
        proposal.createdAt,
      )
    this.audit("learning.proposed", "learning_proposal", proposal.id, { runId: proposal.runId })
    return proposal
  }

  listLearning(status?: LearningStatus) {
    const rows = status
      ? this.db.query("SELECT * FROM agent_learning_proposal WHERE status = ? ORDER BY time_created DESC").all(status)
      : this.db.query("SELECT * FROM agent_learning_proposal ORDER BY time_created DESC").all()
    return (rows as Record<string, unknown>[]).map(decodeLearning)
  }

  approveLearning(id: string) {
    const row = this.db.query("SELECT * FROM agent_learning_proposal WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null
    if (!row) throw new Error(`Learning proposal not found: ${id}`)
    const proposal = decodeLearning(row)
    if (proposal.status !== "proposed") throw new Error(`Learning proposal is already ${proposal.status}`)
    const timestamp = now()
    this.db.transaction(() => {
      this.db
        .query("UPDATE agent_learning_proposal SET status = 'approved', time_reviewed = ? WHERE id = ?")
        .run(timestamp, id)
      this.db
        .query(
          "INSERT INTO agent_skill_revision (id, proposal_id, title, content, content_hash, revision, time_created) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), id, proposal.title, proposal.skillDraft, hash(proposal.skillDraft), 1, timestamp)
    })()
    this.audit("learning.approved", "learning_proposal", id, {})
  }

  rejectLearning(id: string) {
    const result = this.db
      .query(
        "UPDATE agent_learning_proposal SET status = 'rejected', time_reviewed = ? WHERE id = ? AND status = 'proposed'",
      )
      .run(now(), id)
    if (!result.changes) throw new Error(`No pending learning proposal found: ${id}`)
    this.audit("learning.rejected", "learning_proposal", id, {})
  }

  listSkillRevisions() {
    return (
      this.db.query("SELECT * FROM agent_skill_revision ORDER BY time_created DESC").all() as Record<string, unknown>[]
    ).map(decodeSkillRevision)
  }

  revokeSkillRevision(id: string) {
    const revision = this.db.query("SELECT * FROM agent_skill_revision WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null
    if (!revision) throw new Error(`Skill revision not found: ${id}`)
    const proposalId = String(revision.proposal_id)
    this.db.transaction(() => {
      this.db.query("DELETE FROM agent_skill_revision WHERE id = ?").run(id)
      this.db
        .query("UPDATE agent_learning_proposal SET status = 'superseded', time_reviewed = ? WHERE id = ?")
        .run(now(), proposalId)
    })()
    this.audit("skill.revoked", "skill_revision", id, { proposalId })
  }

  createRun(input: {
    mode?: AgentRun["mode"]
    parentRunId?: string
    idempotencyKey?: string
    policy?: Partial<RunPolicy>
  }) {
    const policy: RunPolicy = {
      maxChildren: Math.max(0, Math.min(12, input.policy?.maxChildren ?? 2)),
      maxParallel: Math.max(1, Math.min(12, input.policy?.maxParallel ?? 3)),
      budgetClass: input.policy?.budgetClass ?? "standard",
    }
    if (policy.maxParallel > policy.maxChildren + 1) throw new Error("maxParallel cannot exceed lead plus maxChildren")
    const existing = input.idempotencyKey
      ? (this.db.query("SELECT * FROM agent_run WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<
          string,
          unknown
        > | null)
      : null
    if (existing) return decodeRun(existing)
    const run: AgentRun = {
      id: randomUUID(),
      parentRunId: input.parentRunId,
      mode: input.mode ?? "interactive",
      status: "queued",
      policy,
      idempotencyKey: input.idempotencyKey,
      requestedAt: now(),
    }
    this.db
      .query(
        "INSERT INTO agent_run (id, parent_run_id, mode, status, policy_json, idempotency_key, time_requested) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.parentRunId ?? null,
        run.mode,
        run.status,
        JSON.stringify(run.policy),
        run.idempotencyKey ?? null,
        run.requestedAt,
      )
    this.audit("run.planned", "run", run.id, { policy: run.policy })
    return run
  }

  listRuns() {
    return (
      this.db.query("SELECT * FROM agent_run ORDER BY time_requested DESC").all() as Record<string, unknown>[]
    ).map(decodeRun)
  }

  createSchedule(input: { name: string; expression: string; timezone?: string; payload: string }) {
    const timestamp = now()
    const schedule: AgentSchedule = {
      id: randomUUID(),
      name: input.name.trim(),
      expression: input.expression.trim(),
      timezone: input.timezone?.trim() || "UTC",
      payload: redactSensitive(input.payload).trim(),
      enabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    if (!schedule.name || !schedule.expression || !schedule.payload)
      throw new Error("Schedule name, expression, and payload are required")
    this.db
      .query(
        "INSERT INTO agent_schedule (id, name, expression, timezone, payload, enabled, time_created, time_updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(schedule.id, schedule.name, schedule.expression, schedule.timezone, schedule.payload, timestamp, timestamp)
    this.audit("schedule.created", "schedule", schedule.id, { enabled: false })
    return schedule
  }

  listSchedules() {
    return (
      this.db.query("SELECT * FROM agent_schedule ORDER BY time_created DESC").all() as Record<string, unknown>[]
    ).map(
      (row) =>
        ({
          id: String(row.id),
          name: String(row.name),
          expression: String(row.expression),
          timezone: String(row.timezone),
          payload: String(row.payload),
          enabled: asBoolean(row.enabled),
          createdAt: Number(row.time_created),
          updatedAt: Number(row.time_updated),
        }) satisfies AgentSchedule,
    )
  }

  setScheduleEnabled(id: string, input: { enabled: boolean; confirmed: boolean }) {
    if (!input.confirmed) throw new Error("Schedule enablement requires an explicit confirmation")
    const timestamp = now()
    const result = this.db
      .query("UPDATE agent_schedule SET enabled = ?, time_updated = ? WHERE id = ?")
      .run(input.enabled ? 1 : 0, timestamp, id)
    if (!result.changes) throw new Error(`Schedule not found: ${id}`)
    this.audit(input.enabled ? "schedule.enabled" : "schedule.disabled", "schedule", id, {})
  }

  registerGatewayConnection(input: {
    channel: GatewayChannel
    label: string
    credentialRef: string
    allowedSenders: string[]
    runtimeMode?: GatewayRuntimeMode
  }) {
    const timestamp = now()
    const label = input.label.trim()
    const allowedSenders = [...new Set(input.allowedSenders.map((sender) => sender.trim()).filter(Boolean))]
    if (!label) throw new Error("Gateway connection label is required")
    if (!allowedSenders.length) throw new Error("Gateway connection requires at least one explicit allowed sender")
    const credentialRef = assertCredentialReference(input.credentialRef)
    const connection: GatewayConnection = {
      id: randomUUID(),
      channel: input.channel,
      label,
      runtimeMode: input.runtimeMode ?? "local",
      credentialRef,
      allowedSenders,
      enabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.db
      .query(
        "INSERT INTO agent_adapter_connection (id, channel, label, runtime_mode, credential_ref, allowed_senders_json, enabled, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        connection.id,
        connection.channel,
        connection.label,
        connection.runtimeMode,
        connection.credentialRef,
        JSON.stringify(connection.allowedSenders),
        timestamp,
        timestamp,
      )
    this.audit("gateway.connection_registered", "adapter_connection", connection.id, {
      channel: connection.channel,
      runtimeMode: connection.runtimeMode,
      enabled: false,
    })
    return connection
  }

  listGatewayConnections() {
    return (
      this.db.query("SELECT * FROM agent_adapter_connection ORDER BY time_created DESC").all() as Record<
        string,
        unknown
      >[]
    ).map(decodeGatewayConnection)
  }

  setGatewayConnectionEnabled(id: string, enabled: boolean) {
    const timestamp = now()
    const result = this.db
      .query("UPDATE agent_adapter_connection SET enabled = ?, time_updated = ? WHERE id = ?")
      .run(enabled ? 1 : 0, timestamp, id)
    if (!result.changes) throw new Error(`Gateway connection not found: ${id}`)
    this.audit(enabled ? "gateway.connection_enabled" : "gateway.connection_disabled", "adapter_connection", id, {})
  }

  reserveGatewayEvent(input: {
    connectionId: string
    eventId: string
    senderId: string
    conversationId: string
  }): GatewayEventReservation {
    const connectionRow = this.db
      .query("SELECT * FROM agent_adapter_connection WHERE id = ?")
      .get(input.connectionId) as Record<string, unknown> | null
    if (!connectionRow) throw new Error(`Gateway connection not found: ${input.connectionId}`)
    const connection = decodeGatewayConnection(connectionRow)
    if (!connection.enabled) return { accepted: false, reason: "connection_disabled" }
    if (!connection.allowedSenders.includes(input.senderId)) return { accepted: false, reason: "sender_not_allowed" }
    const eventId = input.eventId.trim()
    if (!eventId || !input.senderId.trim() || !input.conversationId.trim())
      throw new Error("Gateway event requires non-empty event, sender, and conversation identifiers")
    const id = randomUUID()
    const result = this.db
      .query(
        "INSERT OR IGNORE INTO agent_gateway_event (id, connection_id, event_id, sender_id, conversation_id, dispatch_status, time_received) VALUES (?, ?, ?, ?, ?, 'reserved', ?)",
      )
      .run(id, connection.id, eventId, input.senderId, input.conversationId, now())
    if (!result.changes) return { accepted: false, reason: "duplicate" }
    this.audit("gateway.event_reserved", "gateway_event", id, { connectionId: connection.id, eventId })
    return { accepted: true, eventRecordId: id }
  }

  recordDelivery(input: {
    connectionId: string
    conversationId: string
    runId?: string
    detail?: Record<string, unknown>
  }) {
    const timestamp = now()
    const id = randomUUID()
    this.db
      .query(
        "INSERT INTO agent_delivery (id, connection_id, run_id, conversation_id, status, detail_json, time_created, time_updated) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
      )
      .run(
        id,
        input.connectionId,
        input.runId ?? null,
        input.conversationId,
        JSON.stringify(input.detail ?? {}),
        timestamp,
        timestamp,
      )
    this.audit("gateway.delivery_queued", "delivery", id, { connectionId: input.connectionId, runId: input.runId })
    return id
  }

  claimScheduleExecution(input: {
    scheduleId: string
    scheduledWindow: string
    leaseMs?: number
  }): ScheduleExecutionClaim {
    const schedule = this.db.query("SELECT * FROM agent_schedule WHERE id = ?").get(input.scheduleId) as Record<
      string,
      unknown
    > | null
    if (!schedule) throw new Error(`Schedule not found: ${input.scheduleId}`)
    if (!asBoolean(schedule.enabled)) throw new Error("Cannot claim a disabled schedule")
    if (!input.scheduledWindow.trim()) throw new Error("Schedule execution requires a non-empty scheduled window")
    const timestamp = now()
    const existing = this.db
      .query("SELECT * FROM agent_schedule_execution WHERE schedule_id = ? AND scheduled_window = ?")
      .get(input.scheduleId, input.scheduledWindow) as Record<string, unknown> | null
    if (existing)
      return {
        id: String(existing.id),
        scheduleId: input.scheduleId,
        scheduledWindow: input.scheduledWindow,
        claimed: false,
        leaseExpiresAt: existing.lease_expires_at == null ? undefined : Number(existing.lease_expires_at),
      }
    const leaseExpiresAt = timestamp + Math.max(10_000, Math.min(input.leaseMs ?? 60_000, 15 * 60_000))
    const claim: ScheduleExecutionClaim = {
      id: randomUUID(),
      scheduleId: input.scheduleId,
      scheduledWindow: input.scheduledWindow,
      claimed: true,
      leaseExpiresAt,
    }
    const result = this.db
      .query(
        "INSERT OR IGNORE INTO agent_schedule_execution (id, schedule_id, scheduled_window, status, retry_count, lease_expires_at, time_created, time_updated) VALUES (?, ?, ?, 'claimed', 0, ?, ?, ?)",
      )
      .run(claim.id, claim.scheduleId, claim.scheduledWindow, leaseExpiresAt, timestamp, timestamp)
    if (!result.changes) {
      const replay = this.db
        .query("SELECT * FROM agent_schedule_execution WHERE schedule_id = ? AND scheduled_window = ?")
        .get(input.scheduleId, input.scheduledWindow) as Record<string, unknown>
      return {
        id: String(replay.id),
        scheduleId: input.scheduleId,
        scheduledWindow: input.scheduledWindow,
        claimed: false,
        leaseExpiresAt: replay.lease_expires_at == null ? undefined : Number(replay.lease_expires_at),
      }
    }
    this.audit("schedule.execution_claimed", "schedule_execution", claim.id, {
      scheduleId: claim.scheduleId,
      scheduledWindow: claim.scheduledWindow,
    })
    return claim
  }

  createBrowserHandoff(input: { origin: string; purpose: string }) {
    const timestamp = now()
    const handoff: BrowserHandoff = {
      id: randomUUID(),
      origin: assertBrowserOrigin(input.origin),
      purpose: redactSensitive(input.purpose).trim(),
      status: "awaiting_user",
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    if (!handoff.purpose) throw new Error("Browser handoff requires a non-sensitive purpose")
    this.db
      .query(
        "INSERT INTO agent_browser_handoff (id, origin, purpose, status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(handoff.id, handoff.origin, handoff.purpose, handoff.status, timestamp, timestamp)
    this.audit("browser_handoff.opened", "browser_handoff", handoff.id, { origin: handoff.origin })
    return handoff
  }

  listBrowserHandoffs() {
    return (
      this.db.query("SELECT * FROM agent_browser_handoff ORDER BY time_updated DESC").all() as Record<string, unknown>[]
    ).map(decodeBrowserHandoff)
  }

  transitionBrowserHandoff(id: string, operation: "resume" | "complete" | "cancel") {
    const row = this.db.query("SELECT * FROM agent_browser_handoff WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null
    if (!row) throw new Error(`Browser handoff not found: ${id}`)
    const current = decodeBrowserHandoff(row)
    const timestamp = now()
    if (operation === "resume") {
      if (current.status !== "awaiting_user")
        throw new Error(`Browser handoff ${id} cannot resume from ${current.status}`)
      this.db
        .query("UPDATE agent_browser_handoff SET status = 'resumed', time_updated = ?, time_resumed = ? WHERE id = ?")
        .run(timestamp, timestamp, id)
    }
    if (operation === "complete") {
      if (current.status !== "resumed")
        throw new Error(`Browser handoff ${id} must be resumed before it can be completed by the user`)
      this.db
        .query(
          "UPDATE agent_browser_handoff SET status = 'completed_by_user', time_updated = ?, time_completed = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, id)
    }
    if (operation === "cancel") {
      if (current.status !== "awaiting_user" && current.status !== "resumed")
        throw new Error(`Browser handoff ${id} cannot cancel from ${current.status}`)
      this.db
        .query("UPDATE agent_browser_handoff SET status = 'cancelled', time_updated = ? WHERE id = ?")
        .run(timestamp, id)
    }
    this.audit(`browser_handoff.${operation}d`, "browser_handoff", id, { origin: current.origin })
    return decodeBrowserHandoff(
      this.db.query("SELECT * FROM agent_browser_handoff WHERE id = ?").get(id) as Record<string, unknown>,
    )
  }

  private audit(action: string, entityType: string, entityId: string, detail: Record<string, unknown>) {
    this.db
      .query(
        "INSERT INTO agent_audit (id, action, entity_type, entity_id, detail_json, time_created) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), action, entityType, entityId, JSON.stringify(detail), now())
  }
}
