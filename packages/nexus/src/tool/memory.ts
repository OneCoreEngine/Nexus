import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"

async function memoryStore() {
  return import("../cli/cmd/memory")
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["remember", "recall", "list"]).annotate({
    description: "remember stores a fact, recall searches titles, list shows recent entries",
  }),
  title: Schema.optional(Schema.String.annotate({ description: "Fact title for remember, query for recall" })),
  value: Schema.optional(Schema.String.annotate({ description: "Fact body for remember" })),
  limit: Schema.optional(Schema.Number.annotate({ description: "Max entries for recall/list" })),
})

export const MemoryTool = Tool.define(
  "memory",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "memory", metadata: {}, patterns: [params.action], always: [params.action] })
          const store = yield* Effect.promise(() => memoryStore())
          if (params.action === "remember") {
            if (!params.title || !params.value) {
              throw new Error("remember needs both title and value")
            }
            const entry = store.addLocalMemory({ title: params.title, value: params.value })
            return {
              title: `Remembered: ${entry.title}`,
              output: `Stored memory #${entry.id}: ${entry.title}`,
              metadata: {},
            }
          }
          if (params.action === "recall") {
            if (!params.title) throw new Error("recall needs a query in title")
            const matches = store.searchLocalMemoryTitles({ query: params.title, limit: params.limit ?? 5 })
            return {
              title: `Recalled ${matches.length} memor${matches.length === 1 ? "y" : "ies"}`,
              output:
                matches.length === 0
                  ? "No matching memories."
                  : matches.map((match) => `#${match.id} ${match.title}`).join("\n"),
              metadata: {},
            }
          }
          const entries = store.listLocalMemories({ limit: params.limit ?? 5 })
          return {
            title: `${entries.length} recent memories`,
            output:
              entries.length === 0
                ? "No memories stored yet."
                : entries.map((entry) => `#${entry.id} ${entry.title}: ${entry.value.slice(0, 200)}`).join("\n"),
            metadata: {},
          }
        }),
    }
  }),
)
