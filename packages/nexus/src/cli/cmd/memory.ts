import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { EOL } from "node:os"
import { join } from "node:path"
import { Global } from "@nexus-ai/core/global"
import { cmd } from "./cmd"

const MAX_TITLE_LENGTH = 80
const MAX_VALUE_LENGTH = 1_000
const MAX_LIST_LIMIT = 50
const MAX_SEARCH_LIMIT = 20
export const MEMORY_METADATA_EXPORT = "memory-metadata.json"

export type LocalMemoryEntry = {
  id: number
  title: string
  value: string
  createdAt: number
}

export type LocalMemoryStatus = {
  path: string
  initialized: boolean
  entries: number
}

export type LocalMemoryTitleMatch = Pick<LocalMemoryEntry, "id" | "title" | "createdAt">

export type LocalMemoryMetadataExport = {
  version: 1
  kind: "nexus-local-memory-metadata"
  exportedAt: number
  entries: LocalMemoryTitleMatch[]
}

export function memoryDatabasePath(stateDirectory = Global.Path.state): string {
  return join(stateDirectory, "memory.sqlite")
}

function normalizedBoundedText(value: string, maximum: number, label: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value))
    throw new Error(`${label} must not contain terminal control characters`)
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized || normalized.length > maximum)
    throw new Error(`${label} must contain 1-${maximum} printable characters`)
  return normalized
}

export function containsSensitiveMemoryValue(value: string): boolean {
  return /(?:\bbearer\s+[a-z0-9._~+\/-]{12,}|(?:^|[^a-z0-9])(?:api[_ -]?key|password|otp|(?:session|access|refresh)[_ -]?token|[a-z0-9_-]*token|secret)\s*[:=]\s*\S+|\b(?:sk|pk)_[a-z0-9_-]{16,}|\bghp_[a-z0-9]{20,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----)/i.test(
    value,
  )
}

function sanitizeMemoryValue(value: string): string {
  if (containsSensitiveMemoryValue(value)) return "[redacted: sensitive-looking value]"
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function openMemoryDatabase(stateDirectory: string): Database {
  mkdirSync(stateDirectory, { recursive: true })
  const database = new Database(memoryDatabasePath(stateDirectory), { create: true })
  database.exec(`
    CREATE TABLE IF NOT EXISTS nexus_memory (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS nexus_memory_created_at ON nexus_memory(created_at DESC, id DESC);
  `)
  return database
}

export function memoryStatus(stateDirectory = Global.Path.state): LocalMemoryStatus {
  const path = memoryDatabasePath(stateDirectory)
  if (!existsSync(path)) return { path, initialized: false, entries: 0 }
  const database = new Database(path, { readonly: true })
  try {
    const row = database.query("SELECT COUNT(*) AS count FROM nexus_memory").get() as { count: number }
    return { path, initialized: true, entries: Number(row.count) }
  } finally {
    database.close()
  }
}

export function addLocalMemory(input: {
  title: string
  value: string
  stateDirectory?: string
  createdAt?: number
}): LocalMemoryEntry {
  const title = normalizedBoundedText(input.title, MAX_TITLE_LENGTH, "Memory title")
  const value = normalizedBoundedText(input.value, MAX_VALUE_LENGTH, "Memory value")
  if (containsSensitiveMemoryValue(`${title}\n${value}`)) {
    throw new Error(
      "Memory value looks sensitive and was not persisted. Remove credentials, OTPs, passwords, or session factors.",
    )
  }
  const createdAt = input.createdAt ?? Date.now()
  const database = openMemoryDatabase(input.stateDirectory ?? Global.Path.state)
  try {
    const result = database
      .query("INSERT INTO nexus_memory (title, value, created_at) VALUES ($title, $value, $createdAt)")
      .run({ $title: title, $value: value, $createdAt: createdAt })
    return { id: Number(result.lastInsertRowid), title, value, createdAt }
  } finally {
    database.close()
  }
}

export function listLocalMemories(input: { stateDirectory?: string; limit?: number } = {}): LocalMemoryEntry[] {
  const stateDirectory = input.stateDirectory ?? Global.Path.state
  const path = memoryDatabasePath(stateDirectory)
  if (!existsSync(path)) return []
  const limit = Math.min(Math.max(input.limit ?? 20, 1), MAX_LIST_LIMIT)
  const database = new Database(path, { readonly: true })
  try {
    return database
      .query(
        "SELECT id, title, value, created_at AS createdAt FROM nexus_memory ORDER BY created_at DESC, id DESC LIMIT $limit",
      )
      .all({ $limit: limit }) as LocalMemoryEntry[]
  } finally {
    database.close()
  }
}

function normalizedMemoryID(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Memory ID must be a positive integer")
  return id
}

export function getLocalMemory(input: { id: number; stateDirectory?: string }): LocalMemoryEntry | undefined {
  const id = normalizedMemoryID(input.id)
  const path = memoryDatabasePath(input.stateDirectory ?? Global.Path.state)
  if (!existsSync(path)) return undefined
  const database = new Database(path, { readonly: true })
  try {
    const entry = database
      .query("SELECT id, title, value, created_at AS createdAt FROM nexus_memory WHERE id = $id")
      .get({ $id: id }) as LocalMemoryEntry | null
    return entry ?? undefined
  } finally {
    database.close()
  }
}

export function removeLocalMemory(input: {
  id: number
  confirmed: boolean
  stateDirectory?: string
}): LocalMemoryEntry | undefined {
  const id = normalizedMemoryID(input.id)
  if (!input.confirmed) throw new Error("Removing one local memory entry requires --confirm")
  const path = memoryDatabasePath(input.stateDirectory ?? Global.Path.state)
  if (!existsSync(path)) return undefined
  const database = new Database(path)
  try {
    const removed = database.transaction(() => {
      const entry = database
        .query("SELECT id, title, value, created_at AS createdAt FROM nexus_memory WHERE id = $id")
        .get({ $id: id }) as LocalMemoryEntry | null
      if (!entry) return undefined
      database.query("DELETE FROM nexus_memory WHERE id = $id").run({ $id: id })
      return entry
    })()
    return removed ?? undefined
  } finally {
    database.close()
  }
}

export function updateLocalMemory(input: {
  id: number
  title: string
  value: string
  confirmed: boolean
  stateDirectory?: string
}): LocalMemoryEntry | undefined {
  const id = normalizedMemoryID(input.id)
  if (!input.confirmed) throw new Error("Updating one local memory entry requires --confirm")
  const title = normalizedBoundedText(input.title, MAX_TITLE_LENGTH, "Memory title")
  const value = normalizedBoundedText(input.value, MAX_VALUE_LENGTH, "Memory value")
  if (containsSensitiveMemoryValue(`${title}\n${value}`)) {
    throw new Error(
      "Memory value looks sensitive and was not persisted. Remove credentials, OTPs, passwords, or session factors.",
    )
  }
  const path = memoryDatabasePath(input.stateDirectory ?? Global.Path.state)
  if (!existsSync(path)) return undefined
  const database = new Database(path)
  try {
    const updated = database.transaction(() => {
      const existing = database
        .query("SELECT id, created_at AS createdAt FROM nexus_memory WHERE id = $id")
        .get({ $id: id }) as Pick<LocalMemoryEntry, "id" | "createdAt"> | null
      if (!existing) return undefined
      database
        .query("UPDATE nexus_memory SET title = $title, value = $value WHERE id = $id")
        .run({ $id: id, $title: title, $value: value })
      return { ...existing, title, value }
    })()
    return updated ?? undefined
  } finally {
    database.close()
  }
}

export function searchLocalMemoryTitles(input: {
  query: string
  stateDirectory?: string
  limit?: number
}): LocalMemoryTitleMatch[] {
  const query = normalizedBoundedText(input.query, MAX_TITLE_LENGTH, "Memory title query")
  if (containsSensitiveMemoryValue(query)) throw new Error("Memory title query looks sensitive and was not searched")
  const path = memoryDatabasePath(input.stateDirectory ?? Global.Path.state)
  if (!existsSync(path)) return []
  const limit = Math.min(Math.max(input.limit ?? 10, 1), MAX_SEARCH_LIMIT)
  const database = new Database(path, { readonly: true })
  try {
    return database
      .query(
        "SELECT id, title, created_at AS createdAt FROM nexus_memory WHERE instr(lower(title), lower($query)) > 0 ORDER BY created_at DESC, id DESC LIMIT $limit",
      )
      .all({ $query: query, $limit: limit }) as LocalMemoryTitleMatch[]
  } finally {
    database.close()
  }
}

export async function writeMemoryMetadataExport(input: {
  confirmed: boolean
  stateDirectory?: string
  exportedAt?: number
}): Promise<{ path: string; entries: number }> {
  if (!input.confirmed) throw new Error("Writing local memory metadata requires --confirm")
  const stateDirectory = input.stateDirectory ?? Global.Path.state
  const path = join(stateDirectory, MEMORY_METADATA_EXPORT)
  if (existsSync(path))
    throw new Error(`The fixed ${MEMORY_METADATA_EXPORT} file already exists and was not overwritten`)
  const entries = listLocalMemories({ stateDirectory, limit: MAX_LIST_LIMIT }).map((entry) => ({
    id: entry.id,
    title: sanitizeMemoryValue(entry.title),
    createdAt: entry.createdAt,
  }))
  const payload: LocalMemoryMetadataExport = {
    version: 1,
    kind: "nexus-local-memory-metadata",
    exportedAt: input.exportedAt ?? Date.now(),
    entries,
  }
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(path, JSON.stringify(payload, null, 2) + EOL, { encoding: "utf8", flag: "wx" })
  return { path, entries: entries.length }
}

export function formatMemoryStatus(status: LocalMemoryStatus, format: "table" | "json"): string {
  if (format === "json") return JSON.stringify(status, null, 2)
  return [
    `Local memory database: ${status.initialized ? "initialized" : "not initialized"}`,
    `Stored entries: ${status.entries}`,
    `Location: ${status.path}`,
    "Boundary: entries are added only by explicit command. NEXUS does not auto-capture prompts, sessions, files, credentials, or remote/model data.",
  ].join(EOL)
}

export function formatMemoryList(entries: LocalMemoryEntry[], format: "table" | "json"): string {
  const safe = entries.map((entry) => ({
    ...entry,
    title: sanitizeMemoryValue(entry.title),
    value: sanitizeMemoryValue(entry.value),
  }))
  if (format === "json") return JSON.stringify(safe, null, 2)
  if (safe.length === 0)
    return "No explicit local memory entries. Add one with `nexus memory add --title <title> --value <value>`."
  const lines = ["ID  Title  Value  Saved", "─".repeat(72)]
  for (const entry of safe) {
    lines.push(`${entry.id}  ${entry.title}  ${entry.value}  ${new Date(entry.createdAt).toISOString()}`)
  }
  lines.push(
    "Boundary: local explicit entries only; no automatic prompt/session/file capture, model call, provider request, or remote sync.",
  )
  return lines.join(EOL)
}

export function formatMemoryTitleSearch(entries: LocalMemoryTitleMatch[], format: "table" | "json"): string {
  const safe = entries.map((entry) => ({ ...entry, title: sanitizeMemoryValue(entry.title) }))
  if (format === "json") return JSON.stringify(safe, null, 2)
  if (safe.length === 0) return "No explicit local memory titles matched. Values were not searched."
  const lines = ["ID  Title  Saved", "─".repeat(56)]
  for (const entry of safe) lines.push(`${entry.id}  ${entry.title}  ${new Date(entry.createdAt).toISOString()}`)
  lines.push("Boundary: title-only local search; memory values were not searched or displayed.")
  return lines.join(EOL)
}

export const MemoryAddCommand = cmd({
  command: "add",
  describe: "persist one explicit bounded local memory entry; rejects secret-like values",
  builder: (yargs) =>
    yargs
      .option("title", { type: "string", demandOption: true, describe: "1-80 printable character local memory title" })
      .option("value", {
        type: "string",
        demandOption: true,
        describe: "1-1000 printable character local memory value",
      })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  handler(args) {
    const entry = addLocalMemory({ title: args.title, value: args.value })
    process.stdout.write(formatMemoryList([entry], args.format === "json" ? "json" : "table") + EOL)
  },
})

export const MemoryListCommand = cmd({
  command: "list",
  aliases: ["ls", "$0"],
  describe: "list bounded explicit local memory entries newest first",
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 20, describe: `maximum entries to show (1-${MAX_LIST_LIMIT})` })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  handler(args) {
    process.stdout.write(
      formatMemoryList(listLocalMemories({ limit: args.limit }), args.format === "json" ? "json" : "table") + EOL,
    )
  },
})

export const MemoryShowCommand = cmd({
  command: "show <id>",
  describe: "show one explicit local memory entry by ID without changing it",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", describe: "positive local memory entry ID" })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  handler(args) {
    if (typeof args.id !== "number") throw new Error("Memory ID is required")
    const entry = getLocalMemory({ id: args.id })
    if (!entry) throw new Error(`No local memory entry exists for ID ${args.id}`)
    process.stdout.write(formatMemoryList([entry], args.format === "json" ? "json" : "table") + EOL)
  },
})

export const MemoryRemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["delete"],
  describe: "remove exactly one local memory entry only after explicit confirmation",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", describe: "positive local memory entry ID" })
      .option("confirm", { type: "boolean", default: false, describe: "confirm this one-entry local deletion" }),
  handler(args) {
    if (typeof args.id !== "number") throw new Error("Memory ID is required")
    const removed = removeLocalMemory({ id: args.id, confirmed: args.confirm === true })
    if (!removed) throw new Error(`No local memory entry exists for ID ${args.id}; no deletion was performed`)
    process.stdout.write(`Removed local memory entry #${removed.id}. No other memory entries were changed.${EOL}`)
  },
})

export const MemoryUpdateCommand = cmd({
  command: "update <id>",
  describe: "update exactly one local memory entry only after explicit confirmation",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", describe: "positive local memory entry ID" })
      .option("title", { type: "string", demandOption: true, describe: "1-80 printable character replacement title" })
      .option("value", { type: "string", demandOption: true, describe: "1-1000 printable character replacement value" })
      .option("confirm", { type: "boolean", default: false, describe: "confirm this one-entry local update" }),
  handler(args) {
    if (typeof args.id !== "number") throw new Error("Memory ID is required")
    const updated = updateLocalMemory({
      id: args.id,
      title: args.title,
      value: args.value,
      confirmed: args.confirm === true,
    })
    if (!updated) throw new Error(`No local memory entry exists for ID ${args.id}; no update was performed`)
    process.stdout.write(
      `Updated local memory entry #${updated.id}. No other memory entries were changed, and the value was not echoed.${EOL}`,
    )
  },
})

export const MemorySearchCommand = cmd({
  command: "search <query>",
  describe: "search bounded local memory titles only; values are never searched",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", describe: "1-80 printable title search query" })
      .option("limit", {
        type: "number",
        default: 10,
        describe: `maximum title matches to show (1-${MAX_SEARCH_LIMIT})`,
      })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  handler(args) {
    if (typeof args.query !== "string") throw new Error("Memory title query is required")
    process.stdout.write(
      formatMemoryTitleSearch(
        searchLocalMemoryTitles({ query: args.query, limit: args.limit }),
        args.format === "json" ? "json" : "table",
      ) + EOL,
    )
  },
})

export const MemoryExportMetadataCommand = cmd({
  command: "export-metadata",
  describe: "create one confirmed fixed-name local memory metadata export without values",
  builder: (yargs) =>
    yargs.option("confirm", {
      type: "boolean",
      default: false,
      describe: "confirm creating the fixed metadata-only export",
    }),
  async handler(args) {
    const exported = await writeMemoryMetadataExport({ confirmed: args.confirm === true })
    process.stdout.write(
      `Created ${exported.path} with metadata for ${exported.entries} local memory entries. Values, vault keys, credentials, browser data, shell history, project files, and remote state were not exported.${EOL}`,
    )
  },
})

export const MemoryStatusCommand = cmd({
  command: "status",
  describe: "show local memory storage status without creating it",
  builder: (yargs) =>
    yargs.option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  handler(args) {
    process.stdout.write(formatMemoryStatus(memoryStatus(), args.format === "json" ? "json" : "table") + EOL)
  },
})

export const MemoryCommand = cmd({
  command: "memory",
  aliases: ["memories"],
  describe: "manage explicit local-only cross-session memory entries",
  builder: (yargs) =>
    yargs
      .command(MemoryAddCommand)
      .command(MemoryListCommand)
      .command(MemoryShowCommand)
      .command(MemoryRemoveCommand)
      .command(MemoryUpdateCommand)
      .command(MemorySearchCommand)
      .command(MemoryExportMetadataCommand)
      .command(MemoryStatusCommand)
      .demandCommand(),
  async handler() {},
})
