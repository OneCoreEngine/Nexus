import { Effect, Context, Schema, Layer, Path } from "effect"
import { LayerNode } from "@nexus-ai/core/effect/layer-node"
import { FSUtil } from "@nexus-ai/core/fs-util"
import { Global } from "@nexus-ai/core/global"
import { path } from "@nexus-ai/core/effect/app-node-platform"

export interface Session {
  id: string
  title: string
  startedAt: number
  endedAt?: number
  messages: SessionMessage[]
  summary?: string
  tags?: string[]
}

export interface SessionMessage {
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface SearchOptions {
  query: string
  limit?: number
  offset?: number
  dateFrom?: number
  dateTo?: number
  tags?: string[]
}

export interface SearchResult {
  sessionId: string
  sessionTitle: string
  score: number
  matchedMessages: { role: string; content: string; timestamp: number }[]
  contextBefore?: string
  contextAfter?: string
}

export class SearchError extends Schema.TaggedErrorClass<SearchError>()("SearchError", {
  message: Schema.String,
}) {}

export interface SessionSearchInterface {
  readonly index: (session: Session) => Effect.Effect<void, SearchError>
  readonly search: (options: SearchOptions) => Effect.Effect<SearchResult[], SearchError>
  readonly getSession: (id: string) => Effect.Effect<Session | undefined, SearchError>
  readonly deleteSession: (id: string) => Effect.Effect<void, SearchError>
  readonly listSessions: (limit?: number, offset?: number) => Effect.Effect<Session[]>
}

export class Service extends Context.Service<Service, SessionSearchInterface>()("@nexus/SessionSearch") {}

type SessionIndex = { sessions: Session[] }

const toSearchError = (error: unknown) =>
  error instanceof SearchError
    ? error
    : new SearchError({ message: error instanceof Error ? error.message : String(error) })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const pathService = yield* Path.Path

    const searchDir = pathService.join(Global.Path.data, "session-search")
    yield* fsys.makeDirectory(searchDir, { recursive: true }).pipe(Effect.orDie)

    const indexFile = pathService.join(searchDir, "index.json")
    const sessionsDir = pathService.join(searchDir, "sessions")

    yield* fsys.makeDirectory(sessionsDir, { recursive: true }).pipe(Effect.orDie)

    const loadIndex = Effect.fn("SessionSearch.loadIndex")(function* () {
      const content = yield* fsys.readFileStringSafe(indexFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (content === undefined) return { sessions: [] } satisfies SessionIndex
      return yield* Effect.try({
        try: () => JSON.parse(content) as SessionIndex,
        catch: toSearchError,
      }).pipe(Effect.catch(() => Effect.succeed({ sessions: [] } satisfies SessionIndex)))
    })

    const saveIndex = Effect.fn("SessionSearch.saveIndex")(function* (index: SessionIndex) {
      yield* fsys.writeFileString(indexFile, JSON.stringify(index, null, 2)).pipe(Effect.mapError(toSearchError))
    })

    const index = Effect.fn("SessionSearch.index")(function* (session: Session) {
      const index = yield* loadIndex()
      const existingIdx = index.sessions.findIndex((s) => s.id === session.id)
      if (existingIdx >= 0) {
        index.sessions[existingIdx] = session
      } else {
        index.sessions.unshift(session)
      }
      yield* saveIndex(index)
      yield* fsys
        .writeFileString(pathService.join(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2))
        .pipe(Effect.mapError(toSearchError))
    })

    const search = Effect.fn("SessionSearch.search")(function* (options: SearchOptions) {
      const index = yield* loadIndex()
      const { query, limit = 10, offset = 0, dateFrom, dateTo, tags } = options

      const queryTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0)
      if (queryTerms.length === 0) return []

      let sessions = index.sessions

      if (dateFrom) sessions = sessions.filter((s) => s.startedAt >= dateFrom)
      if (dateTo) sessions = sessions.filter((s) => s.startedAt <= dateTo)
      if (tags && tags.length > 0) {
        sessions = sessions.filter((s) => s.tags && tags.some((t) => s.tags!.includes(t)))
      }

      const results: SearchResult[] = []

      for (const session of sessions) {
        const matchedMessages: SearchResult["matchedMessages"] = []

        for (const message of session.messages) {
          const contentLower = message.content.toLowerCase()
          const matches = queryTerms.filter((term) => contentLower.includes(term))
          if (matches.length > 0) {
            matchedMessages.push({
              role: message.role,
              content: message.content.slice(0, 500),
              timestamp: message.timestamp,
            })
          }
        }

        if (matchedMessages.length > 0) {
          const score = calculateScore(session, queryTerms, matchedMessages)
          results.push({
            sessionId: session.id,
            sessionTitle: session.title,
            score,
            matchedMessages: matchedMessages.slice(0, 5),
          })
        }
      }

      results.sort((a, b) => b.score - a.score)
      return results.slice(offset, offset + limit)
    })

    const getSession = Effect.fn("SessionSearch.getSession")(function* (id: string) {
      const index = yield* loadIndex()
      const session = index.sessions.find((s) => s.id === id)
      if (session) return session

      const file = pathService.join(sessionsDir, `${id}.json`)
      const content = yield* fsys.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (content === undefined) return undefined
      return yield* Effect.try({
        try: () => JSON.parse(content) as Session,
        catch: toSearchError,
      })
    })

    const deleteSession = Effect.fn("SessionSearch.deleteSession")(function* (id: string) {
      const index = yield* loadIndex()
      index.sessions = index.sessions.filter((s) => s.id !== id)
      yield* saveIndex(index)
      yield* fsys.remove(pathService.join(sessionsDir, `${id}.json`), { force: true }).pipe(Effect.ignore)
    })

    const listSessions = Effect.fn("SessionSearch.listSessions")(function* (limit = 50, offset = 0) {
      const index = yield* loadIndex()
      return index.sessions.sort((a, b) => b.startedAt - a.startedAt).slice(offset, offset + limit)
    })

    return Service.of({ index, search, getSession, deleteSession, listSessions })
  }),
)

function calculateScore(
  session: Session,
  queryTerms: string[],
  matchedMessages: SearchResult["matchedMessages"],
): number {
  let score = 0
  for (const msg of matchedMessages) {
    const contentLower = msg.content.toLowerCase()
    for (const term of queryTerms) {
      const count = (contentLower.match(new RegExp(term, "g")) || []).length
      score += count * (msg.role === "user" ? 2 : 1)
    }
  }
  const recencyBoost = Math.max(0, 1 - (Date.now() - session.startedAt) / (30 * 24 * 60 * 60 * 1000))
  score *= 1 + recencyBoost
  return score
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, path],
})

export * as SessionSearch from "."
