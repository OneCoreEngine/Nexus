import { Effect, Context, Schema, Layer } from "effect"
import { LayerNode } from "@nexus-ai/core/effect/layer-node"

export interface Message {
  role: "user" | "assistant" | "system"
  content: string
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface CompressionOptions {
  maxTokens?: number
  targetRatio?: number
  preserveRecent?: number
  strategy?: "summary" | "extractive" | "hybrid"
}

export interface CompressionResult {
  messages: Message[]
  originalTokenCount: number
  compressedTokenCount: number
  compressionRatio: number
  strategy: string
}

export class CompressionError extends Schema.TaggedErrorClass<CompressionError>()("CompressionError", {
  message: Schema.String,
}) {}

export interface CompressionInterface {
  readonly compress: (
    messages: Message[],
    options?: CompressionOptions,
  ) => Effect.Effect<CompressionResult, CompressionError>
  readonly estimateTokens: (text: string) => number
}

export class Service extends Context.Service<Service, CompressionInterface>()("@nexus/Compression") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const estimateTokens = (text: string): number => {
      return Math.ceil(text.length / 4)
    }

    const compress = Effect.fn("Compression.compress")(function* (
      messages: Message[],
      options: CompressionOptions = {},
    ) {
      const { maxTokens = 8000, targetRatio = 0.5, preserveRecent = 10, strategy = "hybrid" } = options

      if (messages.length <= preserveRecent) {
        const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
        return {
          messages,
          originalTokenCount: totalTokens,
          compressedTokenCount: totalTokens,
          compressionRatio: 1,
          strategy: "none",
        }
      }

      const recentMessages = messages.slice(-preserveRecent)
      const olderMessages = messages.slice(0, -preserveRecent)

      const olderContent = olderMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n")
      const olderTokens = estimateTokens(olderContent)

      const targetTokens = Math.min(maxTokens, Math.ceil(olderTokens * targetRatio))

      let compressedContent: string

      if (strategy === "summary" || strategy === "hybrid") {
        compressedContent = yield* Effect.promise(() => summarizeConversation(olderContent, targetTokens))
      } else {
        compressedContent = extractiveCompress(olderContent, targetTokens)
      }

      const compressedOlder: Message = {
        role: "system",
        content: `[Compressed conversation history]\n${compressedContent}`,
        metadata: { compressed: true, originalCount: olderMessages.length },
      }

      const resultMessages = [compressedOlder, ...recentMessages]
      const compressedTokens = resultMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
      const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)

      return {
        messages: resultMessages,
        originalTokenCount: originalTokens,
        compressedTokenCount: compressedTokens,
        compressionRatio: compressedTokens / originalTokens,
        strategy,
      }
    })

    return Service.of({ compress, estimateTokens })
  }),
)

function extractiveCompress(content: string, maxTokens: number): string {
  const sentences = content.split(/(?<=[.!?])\s+/)
  const targetChars = maxTokens * 4
  let result = ""
  let count = 0

  for (const sentence of sentences) {
    if (result.length + sentence.length > targetChars && count > 0) break
    result += (result ? " " : "") + sentence
    count++
  }

  return result || content.slice(0, targetChars)
}

async function summarizeConversation(content: string, maxTokens: number): Promise<string> {
  const prompt = `Summarize this conversation in ${maxTokens} tokens or less, preserving key decisions, facts, and action items:\n\n${content}`

  try {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        prompt,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(30000),
    })

    const data = await response.json()
    return data.response || content.slice(0, maxTokens * 4)
  } catch {
    return extractiveCompress(content, maxTokens)
  }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [],
})

export * as Compression from "."
