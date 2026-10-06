import { LayerNode } from "@nexus-ai/core/effect/layer-node"
import { llmClient } from "@nexus-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@nexus-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@nexus-ai/core/v1/session"
import { serviceUse } from "@nexus-ai/core/effect/service-use"
import { Context, Effect, Layer, Exit } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@nexus-ai/llm"
import { LLMClient } from "@nexus-ai/llm/route"
import type { LLMClientService } from "@nexus-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@nexus-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as Cause from "effect/Cause"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { RotationEngine } from "@/provider/rotation"
import { recordApiUsage } from "@/api/ApiVault"
import {
  checkTaskUsageBudget,
  emptyTaskUsage,
  localBudgetFailure,
  recordCompletedUsage,
  type CompletedUsage,
} from "./llm/budget"
import { classifyTaskRequirements, supportsTaskRequirements, taskTextFromMessages } from "./llm/capability"
import { rankCandidatesAfterPrimary } from "./llm/fallback-order"
import { ProviderV2 } from "@nexus-ai/core/provider"
import { ModelV2 } from "@nexus-ai/core/model"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
  onUsage?: (usage: CompletedUsage & { provider: string }) => void
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@nexus/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via nexus's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @nexus-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          onFinish(event) {
            input.onUsage?.({
              provider: input.model.providerID,
              inputTokens: event.totalUsage.inputTokens,
              outputTokens: event.totalUsage.outputTokens,
              requests: event.steps.length,
            })
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    // Process-global memory of the route that most recently completed a turn.
    let lastGoodRoute: { providerID: string; modelID: string } | undefined

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const alternatives = yield* provider.fallbackModels(input.model.providerID)
            const ModelRouter = yield* Effect.promise(() => import("@/api/ModelRouter"))
            const alias = ModelRouter.resolveModelAlias(input.model.id)
            const compatibleRoutes = ModelRouter.routeModel(alias, { includeLocal: false })

            // Build the exact model candidates (same logical model, multiple providers)
            const exactCandidates: Array<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }> = []
            // Add the originally requested provider/model first
            exactCandidates.push({ providerID: input.model.providerID, modelID: input.model.id })

            // Add other providers that can serve the exact same model alias
            for (const route of compatibleRoutes) {
              if (route.provider !== "ollama" && route.provider !== input.model.providerID) {
                exactCandidates.push({
                  providerID: route.provider as ProviderV2.ID,
                  modelID: route.model as ModelV2.ID,
                })
              }
            }

            // Filter alternatives to remove ones we already included in exactCandidates
            const filteredAlternatives = alternatives.filter(
              (alt) => !exactCandidates.some((ec) => ec.providerID === alt.providerID && ec.modelID === alt.modelID),
            )

            // Preserve the current/manual route as candidate zero. Only later
            // candidates are ranked by static local provider-policy category;
            // no live quota, cost, account, key, or task data is inferred.
            const ranked = rankCandidatesAfterPrimary([...exactCandidates, ...filteredAlternatives])
            // Promote the route that most recently succeeded in this process so
            // later turns stop re-burning through known-bad fallbacks. Candidate
            // zero (manual/current choice) always stays first.
            const previousRoute = lastGoodRoute
            const promoted =
              previousRoute &&
              !ranked.some(
                (candidate) =>
                  candidate.providerID === previousRoute.providerID && candidate.modelID === previousRoute.modelID,
              )
                ? [
                    {
                      providerID: previousRoute.providerID as ProviderV2.ID,
                      modelID: previousRoute.modelID as ModelV2.ID,
                    },
                  ]
                : []
            const candidates = [
              ranked[0],
              ...promoted,
              ...ranked
                .slice(1)
                .filter(
                  (candidate) =>
                    !promoted.some(
                      (entry) => entry.providerID === candidate.providerID && entry.modelID === candidate.modelID,
                    ),
                ),
            ]
            const taskUsage = emptyTaskUsage()
            const taskRequirements = classifyTaskRequirements(taskTextFromMessages(input.messages))
            const onUsage = (usage: CompletedUsage & { provider: string }) => {
              const observed = recordCompletedUsage(taskUsage, usage)
              if (usage.provider !== "ollama") {
                recordApiUsage(usage.provider, observed.inputTokens, observed.outputTokens, observed.requests)
              }
            }

            const toStream = (model: Provider.Model) =>
              Effect.gen(function* () {
                const result = yield* run({ ...input, model, abort: ctrl.signal, onUsage })
                if (result.type === "native") return result.stream

                // Adapter seam: both runtimes expose the same LLMEvent stream. Native
                // already returns one; AI SDK streams are converted here.
                const state = LLMAISDK.adapterState()
                return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
                  e instanceof Error ? e : new Error(String(e)),
                ).pipe(
                  Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                  Stream.flatMap((events) => Stream.fromIterable(events)),
                )
              })

            const attempt = (
              remaining: ReadonlyArray<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }>,
              retryCount = 0,
            ): Effect.Effect<Stream.Stream<LLMEvent, unknown>, unknown> =>
              Effect.gen(function* () {
                const [candidate, ...rest] = remaining
                if (!candidate) return yield* Effect.die(new Error("No fallback model is available"))
                const cap = checkTaskUsageBudget(candidate.providerID, taskUsage)
                if (!cap.allowed) return yield* Effect.die(new Error(localBudgetFailure(cap.reason)))

                // Retry the same provider only while its active key rotation has
                // untried keys. This prevents cycling back to key 1 before switching.
                const nextFallback = (cause: unknown) => {
                  let message =
                    typeof cause === "string" ? cause : cause instanceof Error ? cause.message : String(cause)
                  try {
                    message = Cause.pretty(cause as any)
                  } catch (e) {}
                  if (!RotationEngine.isFallbackable(message)) return undefined

                  return Effect.gen(function* () {
                    const rateLimited = RotationEngine.isRateLimited(message)
                    const credentialFailure =
                      /invalid[_ -]?api[_ -]?key|api[_ -]?key.*(?:invalid|not valid)|(?:invalid|missing).*(?:authentication|credentials)|unauthorized|forbidden|missing authentication header|(?:status|http|error)?\s*[:(]?\s*(?:400|401|403)\b/i.test(
                        message,
                      )
                    const currentUsedKey = yield* provider.currentKey(candidate.providerID)
                    if (currentUsedKey && (rateLimited || credentialFailure)) {
                      const status = rateLimited ? "rate_limited" : "invalid"
                      yield* Effect.promise(() =>
                        import("../api/ApiVault").then((m) =>
                          m.updateApiKeyStatus(candidate.providerID, currentUsedKey, status),
                        ),
                      )
                    }
                    yield* provider.invalidateLanguage(candidate.providerID, candidate.modelID)
                    const sameProviderKeyCount = yield* provider.rotationKeyCount(candidate.providerID)
                    if (sameProviderKeyCount > retryCount + 1) {
                      // Exponential backoff keeps rate-limited key rotation from
                      // hammering the provider; credential failures retry at once.
                      if (rateLimited) {
                        yield* Effect.sleep(`${Math.min(2 ** retryCount * 1000, 8000)} millis`)
                      }
                      yield* Effect.logWarning("provider failed; retrying same provider with next key", {
                        providerID: candidate.providerID,
                        modelID: candidate.modelID,
                        retryCount: retryCount + 1,
                        availableKeys: sameProviderKeyCount,
                      })
                      return yield* attempt(remaining, retryCount + 1)
                    }

                    if (rest.length === 0) return yield* Effect.failCause(cause as Cause.Cause<unknown>)
                    const next = rest[0]
                    yield* Effect.logWarning("provider exhausted; switching model", {
                      fromProviderID: candidate.providerID,
                      fromModelID: candidate.modelID,
                      toProviderID: next.providerID,
                      toModelID: next.modelID,
                    })
                    return yield* attempt(rest, 0)
                  })
                }
                const modelExit = yield* Effect.exit(provider.getModel(candidate.providerID, candidate.modelID))
                if (Exit.isFailure(modelExit)) {
                  const fallback = nextFallback(modelExit.cause)
                  if (fallback) return yield* fallback
                  return yield* Effect.failCause(modelExit.cause)
                }
                // Manual/current choice remains candidate zero. Only fallback candidates are
                // skipped when their known local capability metadata cannot meet the task.
                if (
                  candidate !== candidates[0] &&
                  !supportsTaskRequirements(modelExit.value, taskRequirements) &&
                  rest.length > 0
                ) {
                  yield* Effect.logInfo("skipping incompatible fallback candidate", {
                    providerID: candidate.providerID,
                    modelID: candidate.modelID,
                    tools: taskRequirements.tools,
                    vision: taskRequirements.vision,
                    longContext: taskRequirements.longContext,
                    reasoning: taskRequirements.reasoning,
                  })
                  return yield* attempt(rest, 0)
                }
                const current = yield* toStream(modelExit.value)
                lastGoodRoute = { providerID: candidate.providerID, modelID: candidate.modelID }

                // Hook to reset failures on success
                const currentUsedKey = yield* provider.currentKey(candidate.providerID)
                if (currentUsedKey) {
                  yield* Effect.promise(() =>
                    import("../api/ApiVault").then((m) =>
                      m.updateApiKeyStatus(candidate.providerID, currentUsedKey, "active"),
                    ),
                  )
                }

                return current.pipe(
                  Stream.catchCause((cause) => {
                    const fallback = nextFallback(cause)
                    if (fallback) return Stream.unwrap(fallback)
                    return Stream.failCause(cause)
                  }),
                )
              })

            return yield* attempt(candidates)
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    Permission.node,
    EventV2Bridge.node,
    llmClient,
    RuntimeFlags.node,
  ],
})

export * as LLM from "./llm"
