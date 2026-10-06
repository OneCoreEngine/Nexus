import { LayerNode } from "@nexus-ai/core/effect/layer-node"
import path from "path"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@nexus-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@nexus-ai/core/global"
import { SkillPlugin } from "@nexus-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@nexus-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@nexus-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@nexus-ai/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"
import { isTermuxRuntime } from "@/runtime/task-profile"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const NEXUS_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
const BUNDLED_SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled")

// Built-in skill that ships with nexus. The model's intuition for what an
// nexus.json should look like is often wrong, and nexus hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch nexus's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_NEXUS_SKILL_NAME = "customize-nexus"
const CUSTOMIZE_NEXUS_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating NEXUS's own configuration: nexus.json, nexus.jsonc, files under .nexus/, or files under ~/.config/nexus/. Also use when creating or fixing NEXUS agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring NEXUS itself."
const CUSTOMIZE_NEXUS_SKILL_BODY = SkillPlugin.CustomizeNexusContent

// Built-in skill for app building. Runs the spec ritual (questions, spec.md,
// plan_exit approval) before any app code so demand is never guessed.
const APP_SPEC_SKILL_NAME = "app-spec"
const APP_SPEC_SKILL_DESCRIPTION =
  "Use when the user wants any app or website built: run the spec ritual (max 5 questions, spec.md, plan_exit approval) before any app code. Never guess screens or scope."
const APP_SPEC_SKILL_BODY = SkillPlugin.AppSpecContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
  requires: Schema.optional(
    Schema.Struct({
      bins: Schema.optional(Schema.Array(Schema.String)),
      anyBins: Schema.optional(Schema.Array(Schema.String)),
      env: Schema.optional(Schema.Array(Schema.String)),
      config: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  os: Schema.optional(Schema.Array(Schema.String)),
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isStringArray(data: unknown): data is string[] {
  return Array.isArray(data) && data.every((item) => typeof item === "string")
}

function isSkillIdentity(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

// Malformed gating never drops a skill: the skill loads with gating ignored
// and a warning names the file, so a typo can't silently hide working skills.
function parseGating(data: Record<string, unknown>): {
  requires?: NonNullable<Info["requires"]>
  os?: string[]
  malformed: boolean
} {
  let malformed = false
  let requires: NonNullable<Info["requires"]> | undefined
  let os: string[] | undefined
  if (data.os !== undefined) {
    if (isStringArray(data.os)) os = data.os.map((item) => item.toLowerCase())
    else malformed = true
  }
  if (data.requires !== undefined) {
    const raw = data.requires
    const keys = ["bins", "anyBins", "env", "config"] as const
    if (isRecord(raw) && keys.every((key) => raw[key] === undefined || isStringArray(raw[key]))) {
      const picked: { -readonly [K in keyof NonNullable<Info["requires"]>]?: string[] } = {}
      for (const key of keys) {
        const values = raw[key]
        if (isStringArray(values)) picked[key] = values
      }
      requires = picked
    } else {
      malformed = true
    }
  }
  return { requires, os, malformed }
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
  binCache?: { at: number; bins: string[] }
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillIdentity(md.data)) return
  const gating = parseGating(md.data)
  if (gating.malformed) {
    yield* Effect.logWarning("ignoring malformed skill gating", { skill: match })
  }

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
    ...(gating.requires ? { requires: gating.requires } : {}),
    ...(gating.os ? { os: gating.os } : {}),
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  // Scan bundled skills (ships with nexus)
  if (yield* fsys.isDir(BUNDLED_SKILL_DIR)) {
    yield* scan(state, BUNDLED_SKILL_DIR, SKILL_PATTERN, { scope: "bundled" })
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, NEXUS_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@nexus/Skill") {}

export interface GateContext {
  env: Record<string, string | undefined>
  bins: string[]
  config: unknown
  platform: string
  isTermux: boolean
}

function configTruthy(root: unknown, dotted: string): boolean {
  const value = dotted.split(".").reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), root)
  return Boolean(value)
}

// Load-time eligibility: a skill with `requires`/`os` frontmatter only shows
// up when its environment is present. Keeps PC-only and Termux-only skills
// out of each other's prompts, and saves context on every turn.
export function meetsGate(info: Info, ctx: GateContext): boolean {
  if (info.os && !info.os.some((os) => os === ctx.platform || (os === "termux" && ctx.isTermux))) return false
  const requires = info.requires
  if (!requires) return true
  const bins = ctx.platform === "win32" ? ctx.bins.map((bin) => bin.toLowerCase()) : ctx.bins
  const want = (bin: string) => bins.includes(ctx.platform === "win32" ? bin.toLowerCase() : bin)
  if (requires.env && requires.env.some((key) => !ctx.env[key])) return false
  if (requires.bins && requires.bins.some((bin) => !want(bin))) return false
  if (requires.anyBins && requires.anyBins.length > 0 && !requires.anyBins.some((bin) => want(bin))) return false
  if (requires.config && requires.config.some((key) => !configTruthy(ctx.config, key))) return false
  return true
}

function pathBins(): string[] {
  const found = new Set<string>()
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      found.add(process.platform === "win32" ? entry.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "") : entry)
    }
  }
  return [...found]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_NEXUS_SKILL_NAME] = {
          name: CUSTOMIZE_NEXUS_SKILL_NAME,
          description: CUSTOMIZE_NEXUS_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_NEXUS_SKILL_BODY,
        }
        s.skills[APP_SPEC_SKILL_NAME] = {
          name: APP_SPEC_SKILL_NAME,
          description: APP_SPEC_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: APP_SPEC_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const now = Date.now()
      if (!s.binCache || now - s.binCache.at > 60_000) {
        s.binCache = { at: now, bins: pathBins() }
      }
      const cfg: unknown = yield* config.get()
      const gate: GateContext = {
        env: process.env,
        bins: s.binCache.bins,
        config: cfg,
        platform: process.platform,
        isTermux: isTermuxRuntime(),
      }
      const list = Object.values(s.skills)
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .filter((skill) => meetsGate(skill, gate))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available })
  }),
)

// Default prompt budget for skill listings. Lists longer than this render
// compact (identities only) so skills cost a bounded number of tokens.
export const SKILL_PROMPT_BUDGET_CHARS = 4000

export function fmt(list: Info[], opts: { verbose: boolean; maxChars?: number }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  const full = opts.verbose
    ? [
        "<available_skills>",
        ...described
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .flatMap((skill) => [
            "  <skill>",
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `    <location>${escapeHtml(skill.location)}</location>`,
            "  </skill>",
          ]),
        "</available_skills>",
      ].join("\n")
    : [
        "## Available Skills",
        ...described
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map((skill) => `- **${skill.name}**: ${skill.description}`),
      ].join("\n")
  if (full.length <= (opts.maxChars ?? SKILL_PROMPT_BUDGET_CHARS)) return full
  // Compact keeps every listed identity with locations but drops descriptions,
  // so it stays strictly shorter than the full rendering it replaces.
  const compact = opts.verbose
    ? [
        "<available_skills>",
        ...described
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .flatMap((skill) => [
            "  <skill>",
            `    <name>${skill.name}</name>`,
            `    <location>${escapeHtml(skill.location)}</location>`,
            "  </skill>",
          ]),
        "</available_skills>",
      ].join("\n")
    : [
        "## Available Skills",
        ...described
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map((skill) => `- **${skill.name}** (\`${skill.location}\`)`),
        "",
        "Descriptions omitted to fit the prompt budget. Use the skill tool to load a skill by name.",
      ].join("\n")
  return compact
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
