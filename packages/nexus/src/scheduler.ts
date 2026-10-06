import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Global } from "@nexus-ai/core/global"

// Persistent scheduler store. Survives process restarts (unlike the
// process-local BackgroundJob registry) so Termux kills never lose a
// reminder. File-backed JSON: no new database tables, human-inspectable.

export interface ScheduledJob {
  id: string
  kind: "once" | "cron"
  at?: number
  expr?: string
  instructions: string
  createdAt: number
  lastRun?: number
  runs: number
}

export interface Store {
  jobs: ScheduledJob[]
}

export function storePath(stateDirectory: string = Global.Path.state): string {
  return path.join(stateDirectory, "scheduler.json")
}

export function loadStore(stateDirectory: string = Global.Path.state): Store {
  try {
    const data: unknown = JSON.parse(readFileSync(storePath(stateDirectory), "utf8"))
    if (data && typeof data === "object" && "jobs" in data && Array.isArray(data.jobs)) {
      return { jobs: data.jobs.filter((job): job is ScheduledJob => isJob(job)) }
    }
  } catch {
    // No store yet.
  }
  return { jobs: [] }
}

function isJob(value: unknown): value is ScheduledJob {
  if (!value || typeof value !== "object") return false
  const job = value as Record<string, unknown>
  return (
    typeof job.id === "string" &&
    (job.kind === "once" || job.kind === "cron") &&
    typeof job.instructions === "string" &&
    typeof job.createdAt === "number" &&
    typeof job.runs === "number"
  )
}

export function saveStore(store: Store, stateDirectory: string = Global.Path.state): void {
  mkdirSync(stateDirectory, { recursive: true })
  writeFileSync(storePath(stateDirectory), JSON.stringify(store, null, 2))
}

export function addJob(store: Store, job: Omit<ScheduledJob, "createdAt" | "runs">, now = Date.now()): Store {
  if (job.kind === "once" && (typeof job.at !== "number" || Number.isNaN(job.at))) {
    throw new Error("one-shot jobs need a valid `at` timestamp")
  }
  if (job.kind === "cron" && (typeof job.expr !== "string" || !parseCron(job.expr))) {
    throw new Error("cron jobs need a valid 5-field `expr`")
  }
  // Same id replaces: scheduling is idempotent, never a silent duplicate pool.
  return { jobs: [...store.jobs.filter((item) => item.id !== job.id), { ...job, createdAt: now, runs: 0 }] }
}

export function removeJob(store: Store, id: string): { store: Store; removed: boolean } {
  const jobs = store.jobs.filter((job) => job.id !== id)
  return { store: { jobs }, removed: jobs.length !== store.jobs.length }
}

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
}

function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>()
  for (const part of field.split(",")) {
    if (!part) return undefined
    const stepSplit = part.split("/")
    if (stepSplit.length > 2) return undefined
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1
    if (!Number.isInteger(step) || step < 1) return undefined
    const range = stepSplit[0]
    if (!range) return undefined
    let from = min
    let to = max
    if (range !== "*") {
      const bounds = range.split("-")
      if (bounds.length > 2) return undefined
      from = Number(bounds[0])
      to = bounds.length === 2 ? Number(bounds[1]) : from
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return undefined
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values.size > 0 ? values : undefined
}

// Standard 5-field cron: minute hour day-of-month month day-of-week.
// Supports *, lists, ranges, and steps. Returns undefined for bad input.
export function parseCron(expr: string): CronFields | undefined {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  const parsed = {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    month: parseField(month, 1, 12),
    dayOfWeek: parseField(dayOfWeek, 0, 6),
  }
  if (!parsed.minute || !parsed.hour || !parsed.dayOfMonth || !parsed.month || !parsed.dayOfWeek) return undefined
  return {
    minute: parsed.minute,
    hour: parsed.hour,
    dayOfMonth: parsed.dayOfMonth,
    month: parsed.month,
    dayOfWeek: parsed.dayOfWeek,
  }
}

function matchesDay(date: Date, cron: CronFields): boolean {
  const domMatch = cron.dayOfMonth.has(date.getDate())
  const dowMatch = cron.dayOfWeek.has(date.getDay())
  const domStar = cron.dayOfMonth.size === 31
  const dowStar = cron.dayOfWeek.size === 7
  // Standard cron: when both day fields are restricted, either may match.
  if (!domStar && !dowStar) return domMatch || dowMatch
  return domMatch && dowMatch
}

// Next run strictly after `fromMs`. Scans forward minute by minute, capped at
// one year so a broken expression can never hang the scheduler.
export function nextRun(cron: CronFields, fromMs: number): number | undefined {
  let cursor = Math.floor(fromMs / 60000) * 60000 + 60000
  const limit = fromMs + 366 * 24 * 60 * 60000
  while (cursor <= limit) {
    const date = new Date(cursor)
    if (
      cron.minute.has(date.getMinutes()) &&
      cron.hour.has(date.getHours()) &&
      cron.month.has(date.getMonth() + 1) &&
      matchesDay(date, cron)
    ) {
      return cursor
    }
    cursor += 60000
  }
  return undefined
}

export interface DueJob {
  job: ScheduledJob
  reason: string
}

// Jobs due at `now`: one-shots past their time that never ran, crons whose
// window since lastRun (or creation) contains a scheduled fire time.
export function dueJobs(store: Store, now = Date.now()): DueJob[] {
  const due: DueJob[] = []
  for (const job of store.jobs) {
    if (job.kind === "once") {
      if (job.at !== undefined && job.at <= now && job.lastRun === undefined) {
        due.push({ job, reason: "one-shot time reached" })
      }
      continue
    }
    if (!job.expr) continue
    const cron = parseCron(job.expr)
    if (!cron) continue
    const since = job.lastRun ?? job.createdAt
    const next = nextRun(cron, since)
    if (next !== undefined && next <= now) {
      due.push({ job, reason: `cron fired (last run ${new Date(since).toISOString()})` })
    }
  }
  return due
}

export function markRun(store: Store, id: string, now = Date.now()): Store {
  return {
    jobs: store.jobs.map((job) => (job.id === id ? { ...job, lastRun: now, runs: job.runs + 1 } : job)),
  }
}

export function describeJob(job: ScheduledJob): string {
  const when = job.kind === "once" && job.at !== undefined ? new Date(job.at).toISOString() : (job.expr ?? "?")
  return `${job.id} [${job.kind} ${when}] runs=${job.runs}${job.lastRun ? ` last=${new Date(job.lastRun).toISOString()}` : ""} :: ${job.instructions.slice(0, 80)}`
}
