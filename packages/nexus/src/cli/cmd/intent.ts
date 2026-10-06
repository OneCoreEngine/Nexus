import { EOL } from "node:os"
import { cmd } from "./cmd"
import { Effect } from "effect"
import {
  apiVaultKeyPath,
  apiVaultPublicRows,
  apiVaultRows,
  getApiUsageBudget,
  getApiVaultStatus,
} from "../../api/ApiVault"
import { formatApiReadiness, formatApiRoutePreview, formatApiUsageBudget, formatApiVaultList } from "./api"
import {
  formatSpecialistRole,
  formatSpecialistRoles,
  specialistRoleNames,
  type SpecialistRoleName,
} from "./agent-roles"
import {
  agentCapabilityStatus,
  agentCapabilitySections,
  formatAgentCapabilityStatus,
  type AgentCapabilitySection,
  type AgentCapabilityStatus,
} from "./agent-status"
import { createAgentPlanPreview, formatAgentPlanPreview, type AgentPlanPreview } from "./agent-plan-preview"
import { collectDeviceReadiness, formatDeviceReadiness } from "./device"
import { formatInstructionExplanation, formatInstructionStatus } from "./instructions"
import { formatMemoryList, formatMemoryStatus, getLocalMemory, listLocalMemories, memoryStatus } from "./memory"
import {
  clearWorkspaceSelection,
  formatWorkspaceDetail,
  formatWorkspaceList,
  formatWorkspaceSelection,
  readWorkspaceSelection,
} from "./workspace"
import {
  formatPermissionInspection,
  inspectablePermissionCategories,
  type InspectablePermissionCategory,
} from "./permission"
import {
  collectTranslationFiles,
  createTranslationPlan,
  formatTranslationPlan,
  translationLanguages,
  type TranslationLanguage,
  writeTranslationReport,
} from "./translator"
import { getDeviceConfig } from "@nexus-ai/core/device"
import { formatLocalModelCatalog, formatLocalModelRecommendations } from "./local-models"
import { routeModel } from "../../api/ModelRouter"
import { Permission } from "@/permission"
import { Project } from "@/project/project"
import { AgentPlatformStore } from "../../agent-platform/store"
import { readLocalGatewayState } from "../../agent-platform/gateway-local"

const MAX_INTENT_INPUT_LENGTH = 1_000
const CONFIRMED_TRANSLATION_REPORT = ".nexus-translation-plan.json"

export type IntentInspection = {
  category:
    | "code"
    | "diagnostics"
    | "workspace"
    | "workspace-mutation"
    | "translation"
    | "version-control"
    | "api-status"
    | "agent-role"
    | "agent-status"
    | "agent-plan-preview"
    | "permission"
    | "device"
    | "instructions"
    | "memory"
    | "local-model"
    | "model-route"
    | "termux"
    | "voice"
    | "webtest"
    | "unknown"
    | "sensitive-input"
    | "input-too-long"
  plugin?: string
  command?: string
  confidence: "high" | "none"
  execution: "not-run"
}

type IntentRule = Pick<IntentInspection, "category" | "plugin" | "command"> & { pattern: RegExp }

const intentRules: readonly IntentRule[] = [
  {
    pattern: /(?:code|project|app|website|portfolio|todo).*(?:banao|bana|generate|create|scaffold)/i,
    category: "code",
    plugin: "codegen",
    command: "generate",
  },
  {
    pattern: /(?:env|environment|variable|\.env).*(?:check|scan|detect|missing|fix)?/i,
    category: "diagnostics",
    plugin: "devtools",
    command: "env:scan",
  },
  {
    pattern: /(?:error|bug).*(?:fix|doctor|explain)|(?:log)\s*doctor/i,
    category: "diagnostics",
    plugin: "devtools",
    command: "doctor:explain",
  },
  {
    pattern:
      /(?:clear|remove|delete|hatado|hata do).*(?:workspace|project).*(?:bookmark|selection)|(?:workspace|project).*(?:bookmark|selection).*(?:clear|remove|delete|hatado|hata do)/i,
    category: "workspace-mutation",
    plugin: "workspace",
    command: "clear selection bookmark",
  },
  {
    pattern:
      /(?:(?:workspace|project).*(?:selected|current|active)|(?:selected|current|active).*(?:workspace|project)).*(?:status|which|kaun|konsa|kon sa|show|dikhao)?/i,
    category: "workspace",
    plugin: "workspace",
    command: "selected",
  },
  {
    pattern: /(?:workspace|project).*(?:show|details?|detail|info|information)/i,
    category: "workspace",
    plugin: "workspace",
    command: "show",
  },
  {
    pattern: /(?:workspace|project).*(?:list|naam|name)/i,
    category: "workspace",
    plugin: "workspace",
    command: "list",
  },
  {
    pattern:
      /(?:(?:translate|translation|convert|badlo).*(?:php|python|go|typescript|javascript).*(?:report|save|write)|(?:php|python|go|typescript|javascript).*(?:translate|translation|convert|badlo).*(?:report|save|write))/i,
    category: "translation",
    plugin: "translator",
    command: "confirmed report",
  },
  {
    pattern:
      /(?:(?:translate|translation|convert|badlo).*(?:php|python|go|typescript|javascript))|(?:(?:php|python|go|typescript|javascript).*(?:translate|translation|convert|badlo))/i,
    category: "translation",
    plugin: "translator",
    command: "plan",
  },
  { pattern: /(?:commit|git\s*review|pr\s*banao)/i, category: "version-control", plugin: "gitpro", command: "commit" },
  {
    pattern: /(?:api|keys?|key).*(?:readiness|ready)|(?:readiness|ready).*(?:api|keys?|key)/i,
    category: "api-status",
    plugin: "api",
    command: "readiness",
  },
  {
    pattern:
      /(?:local|offline|device).*(?:model).*(?:catalog|recommendations?|recommend|suggest|ram|storage|gpu|download)|(?:catalog|recommendations?|recommend|suggest).*(?:local|offline|device).*(?:model)/i,
    category: "local-model",
    plugin: "models",
    command: "local recommendations",
  },
  {
    pattern:
      /(?:deepseek|llama\s*3(?:\.1)?|gemini|gpt\s*-?4).*(?:model\s*)?(?:route|fallback|provider)|(?:route|fallback|provider).*(?:deepseek|llama\s*3(?:\.1)?|gemini|gpt\s*-?4)/i,
    category: "model-route",
    plugin: "api",
    command: "route preview",
  },
  {
    pattern: /(?:api|requests?|tokens?).*(?:budget|caps?|limits?)|(?:budget|caps?|limits?).*(?:api|requests?|tokens?)/i,
    category: "api-status",
    plugin: "api",
    command: "budget",
  },
  {
    pattern:
      /(?:api|keys?|key).*(?:list|status|usage|tokens?|total|kitne|kitna|remaining|bache|bach|health)|(?:list|status|usage|tokens?|total|kitne|kitna|remaining|bache|bach|health).*(?:api|keys?|key)/i,
    category: "api-status",
    plugin: "api",
    command: "list",
  },
  {
    pattern: /(?=.*\b(?:planner|coder|reviewer|tester)\b)(?=.*\b(?:plan|preview)\b).*$/i,
    category: "agent-plan-preview",
    plugin: "agent",
    command: "plan preview",
  },
  {
    pattern:
      /^(?!.*\b(?:create|add|approve|reject|revoke|enable|disable|run|start|stop|poll|send|connect|credential|token|set|write|save|edit|delete|remove|clear)\b)(?!.*\b(?:role|roles|planner|coder|reviewer|tester)\b)(?=.*\b(?:agent|learning|scheduler|schedule|subagent|subagents|sub-agent|gateway)\b)(?=.*\b(?:status|readiness|capacity|capability|state|inspect|check|dikhao|dekhao)\b).*$/i,
    category: "agent-status",
    plugin: "agent",
    command: "status",
  },
  {
    pattern:
      /(?:agent\s*)?roles?.*(?:list|all|available|saare|sab)|(?:list|all|available|saare|sab).*(?:agent\s*)?roles?/i,
    category: "agent-role",
    plugin: "agent",
    command: "role list",
  },
  {
    pattern:
      /(?:agent\s*)?(?:role|planner|coder|reviewer|tester).*(?:show|policy|rules?|constraints?|settings?|details?|info|information|dekhao|dikhao)|(?:show|policy|rules?|constraints?|settings?|details?|info|information|dekhao|dikhao).*(?:agent\s*)?(?:role|planner|coder|reviewer|tester)/i,
    category: "agent-role",
    plugin: "agent",
    command: "role show",
  },
  {
    pattern:
      /(?:permission|allow|deny|denied|access).*(?:explain|check|inspect|status|kyu|kyon|why)|(?:bash|edit|read|webfetch|question).*(?:permission|allow|deny|denied)/i,
    category: "permission",
    plugin: "permission",
    command: "explain",
  },
  {
    pattern:
      /(?:instructions?|nexus\.md|agents\.md|claude\.md|context\.md).*(?:explain|precedence|order|priority|rules?)|(?:explain|precedence|order|priority).*(?:instructions?|nexus\.md|agents\.md|claude\.md|context\.md)/i,
    category: "instructions",
    plugin: "instructions",
    command: "explain",
  },
  {
    pattern:
      /(?:instructions?|nexus\.md|agents\.md|claude\.md|context\.md).*(?:status|list|show|dikhao|dekhao|check)|(?:status|list|show|dikhao|dekhao|check).*(?:instructions?|nexus\.md|agents\.md|claude\.md|context\.md)/i,
    category: "instructions",
    plugin: "instructions",
    command: "status",
  },
  {
    pattern:
      /(?:device|termux|android|pc|phone).*(?:readiness|ready|ram|memory|storage|battery|thermal)|(?:readiness|ram|memory|storage|battery|thermal).*(?:device|termux|android|pc|phone)/i,
    category: "device",
    plugin: "device",
    command: "readiness",
  },
  {
    pattern:
      /^(?!.*\b(?:add|update|remove|delete|clear|export|import|save|write)\b)(?:(?:(?:local\s+)?memor(?:y|ies).*(?:show|entry|id|details?|dikhao|dekhao).*?\b\d+\b)|(?:(?:show|entry|id|details?|dikhao|dekhao).*(?:local\s+)?memor(?:y|ies).*?\b\d+\b))/i,
    category: "memory",
    plugin: "memory",
    command: "show",
  },
  {
    pattern:
      /^(?!.*\b(?:add|update|remove|delete|clear|export|import|save|write)\b)(?:(?:(?:local\s+)?memor(?:y|ies).*(?:status|storage|state))|(?:(?:status|storage|state).*(?:local\s+)?memor(?:y|ies)))/i,
    category: "memory",
    plugin: "memory",
    command: "status",
  },
  {
    pattern:
      /^(?!.*\b(?:add|update|remove|delete|clear|export|import|save|write)\b)(?:(?:(?:local\s+)?memor(?:y|ies).*(?:list|entries|all|saare|sab))|(?:(?:list|entries|all|saare|sab).*(?:local\s+)?memor(?:y|ies)))/i,
    category: "memory",
    plugin: "memory",
    command: "list",
  },
  {
    pattern: /(?:notification|notify|toast|battery|clipboard|apk|location)/i,
    category: "termux",
    plugin: "termux",
    command: "run",
  },
  { pattern: /(?:voice|bol|sun|speak|listen|awaaz)/i, category: "voice", plugin: "voice", command: "listen" },
  {
    pattern: /(?:website|site|page|url).*(?:test|check|bugs?)|(?:design|ui|ux|layout).*(?:check|review|analyze|qa)/i,
    category: "webtest",
    plugin: "webtest",
    command: "run",
  },
]

function containsSensitiveValue(value: string): boolean {
  return /(?:\bbearer\s+[a-z0-9._~+\/-]{12,}|\b(?:api[_ -]?key|password|otp|session[_ -]?token)\s*[:=]\s*\S+|\b(?:sk|pk)_[a-z0-9_-]{16,}|\bghp_[a-z0-9]{20,})/i.test(
    value,
  )
}

export function inspectIntent(value: string): IntentInspection {
  if (value.length > MAX_INTENT_INPUT_LENGTH)
    return { category: "input-too-long", confidence: "none", execution: "not-run" }
  if (containsSensitiveValue(value)) return { category: "sensitive-input", confidence: "none", execution: "not-run" }
  for (const rule of intentRules) {
    if (rule.pattern.test(value)) {
      return {
        category: rule.category,
        plugin: rule.plugin,
        command: rule.command,
        confidence: "high",
        execution: "not-run",
      }
    }
  }
  return { category: "unknown", confidence: "none", execution: "not-run" }
}

export function formatIntentInspection(result: IntentInspection, format: "table" | "json"): string {
  if (format === "json") return JSON.stringify(result, null, 2)
  const lines = [
    `Category: ${result.category}`,
    `Suggested local route: ${result.plugin && result.command ? `${result.plugin}:${result.command}` : "none"}`,
    `Confidence: ${result.confidence}`,
    "Execution: not run",
  ]
  if (result.category === "sensitive-input")
    lines.push(
      "Sensitive-looking input was not classified or echoed. Remove it and retry with a non-secret task description.",
    )
  else if (result.category === "input-too-long")
    lines.push("Input exceeded the local inspection bound and was not classified.")
  else
    lines.push(
      "Inspection only: no model call, plugin load, command execution, install, write, or persistent route preference occurred.",
    )
  return lines.join(EOL)
}

export type IntentExecution = Omit<IntentInspection, "execution"> & {
  execution: "executed" | "blocked"
  result?: string
  reason?: string
}

export type IntentExecutionOptions = {
  confirmLocal?: boolean
  memoryStateDirectory?: string
  workspaceSelectionDirectory?: string
  translationRoot?: string
  /** Test-only existing registry fixture; production uses the initialized local Project service. */
  workspaceProjects?: () => Promise<Project.Info[]>
  /** Test-only fixed-category formatter; production reads the initialized local permission configuration. */
  permissionExplanation?: (category: InspectablePermissionCategory) => Promise<string>
  /** Test-only local agent capability fixture; production only reads existing local metadata. */
  agentCapabilityStatus?: () => Promise<AgentCapabilityStatus>
  /** Test-only non-persistent preview fixture; production observes only current local device signals. */
  agentPlanPreview?: (input: {
    role: SpecialistRoleName
    children: number
    parallel: number
    budget: "low" | "standard" | "high"
  }) => Promise<AgentPlanPreview>
}

function roleNamedIn(value: string): SpecialistRoleName | undefined {
  return specialistRoleNames.find((role) => new RegExp(`\\b${role}\\b`, "i").test(value))
}

function blockedExecution(inspection: IntentInspection, reason: string): IntentExecution {
  return { ...inspection, execution: "blocked", reason }
}

function requestedTranslationLanguages(
  value: string,
): { source: TranslationLanguage; target: TranslationLanguage } | undefined {
  const names = new RegExp(`\\b(${translationLanguages.join("|")})\\b`, "gi")
  const found: TranslationLanguage[] = []
  for (const match of value.matchAll(names)) {
    const language = match[1].toLowerCase() as TranslationLanguage
    if (!found.includes(language)) found.push(language)
  }
  if (found.length !== 2 || found[0] === found[1]) return undefined
  return { source: found[0], target: found[1] }
}

function requestedKnownModelAlias(value: string): "deepseek" | "llama3_1" | "gemini" | "gpt4" | undefined {
  if (/\bdeepseek\b/i.test(value)) return "deepseek"
  if (/\bllama\s*3(?:\.1)?\b/i.test(value)) return "llama3_1"
  if (/\bgemini\b/i.test(value)) return "gemini"
  if (/\bgpt\s*-?4\b/i.test(value)) return "gpt4"
  return undefined
}

function requestedMemoryID(value: string): number | undefined {
  const patterns = [
    /\b(?:local\s+)?memor(?:y|ies)\s+(?:show|entry|id|details?|dikhao|dekhao)\s*(?:#|id\s*)?(\d+)\b/i,
    /\b(?:show|entry|id|details?|dikhao|dekhao)\s+(?:local\s+)?memor(?:y|ies)\s*(?:#|id\s*)?(\d+)\b/i,
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) return Number(match[1])
  }
  return undefined
}

function hasUnsafeWorkspaceExecutionWording(value: string): boolean {
  return /(?:\b(?:select|rename|clear|delete|remove|set|change|switch|write|save|config|source|session|shell|directory|path)\b|[\\/]|--)/i.test(
    value,
  )
}

function requestedPermissionCategory(value: string): InspectablePermissionCategory | undefined {
  const found = inspectablePermissionCategories.filter((category) => new RegExp(`\\b${category}\\b`, "i").test(value))
  return found.length === 1 ? found[0] : undefined
}

function hasUnsafePermissionExplanationWording(value: string): boolean {
  return /(?:[\\/]|--|\b(?:command|path|rule|pattern|edit|write|save|set|change|run|execute)\b)/i.test(value)
}

function requestedAgentCapabilitySection(value: string): AgentCapabilitySection | undefined | "ambiguous" {
  const matched = agentCapabilitySections.filter((section) => {
    if (section === "scheduler") return /\b(?:scheduler|schedule)\b/i.test(value)
    if (section === "subagents") return /\b(?:subagent|subagents|sub-agent|roles?)\b/i.test(value)
    return new RegExp(`\\b${section}\\b`, "i").test(value)
  })
  return matched.length === 0 ? undefined : matched.length === 1 ? matched[0] : "ambiguous"
}

function hasUnsafeAgentCapabilityStatusWording(value: string): boolean {
  return /(?:[\\/]|--|\b(?:create|add|approve|reject|revoke|enable|disable|run|start|stop|poll|send|connect|credential|token|set|write|save|edit|delete|remove|clear)\b)/i.test(
    value,
  )
}

type AgentPlanPreviewRequest = {
  role: SpecialistRoleName
  children: number
  parallel: number
  budget: "low" | "standard" | "high"
}

function singlePlanNumber(value: string, noun: "children" | "parallel"): number | undefined | "ambiguous" {
  const singular = noun === "children" ? "child(?:ren)?" : "parallel"
  const matches = Array.from(
    value.matchAll(new RegExp(`(?:\\b(-?\\d+)\\s+${singular}\\b|\\b${singular}\\s+(-?\\d+)\\b)`, "gi")),
  ).map((match) => Number(match[1] ?? match[2]))
  if (matches.length > 1 || (new RegExp(`\\b${singular}\\b`, "i").test(value) && matches.length !== 1))
    return "ambiguous"
  return matches[0]
}

function requestedAgentPlanPreview(value: string): AgentPlanPreviewRequest | "ambiguous" {
  const roles = specialistRoleNames.filter((role) => new RegExp(`\\b${role}\\b`, "i").test(value))
  if (roles.length !== 1) return "ambiguous"
  const children = singlePlanNumber(value, "children")
  const parallel = singlePlanNumber(value, "parallel")
  if (children === "ambiguous" || parallel === "ambiguous") return "ambiguous"
  const budgetMatches = Array.from(
    value.matchAll(/(?:\b(low|standard|high)\s+budget\b|\bbudget\s+(low|standard|high)\b)/gi),
  ).map((match) => (match[1] ?? match[2]) as "low" | "standard" | "high")
  if (budgetMatches.length > 1 || (/\bbudget\b/i.test(value) && budgetMatches.length !== 1)) return "ambiguous"
  const request = {
    role: roles[0],
    children: children ?? 0,
    parallel: parallel ?? 1,
    budget: budgetMatches[0] ?? "standard",
  }
  if (
    request.children < 0 ||
    request.children > 12 ||
    request.parallel < 1 ||
    request.parallel > 12 ||
    request.parallel > request.children + 1
  )
    return "ambiguous"
  return request
}

function hasUnsafeAgentPlanPreviewWording(value: string): boolean {
  return /(?:[\\/]|--|\b(?:create|add|approve|reject|revoke|enable|disable|run|start|stop|poll|send|connect|credential|token|set|write|save|edit|delete|remove|clear|queue|persist|durable|idempotency)\b)/i.test(
    value,
  )
}

async function localAgentCapabilityStatus(options: IntentExecutionOptions): Promise<AgentCapabilityStatus> {
  if (options.agentCapabilityStatus) return options.agentCapabilityStatus()
  const store = new AgentPlatformStore()
  try {
    return agentCapabilityStatus({
      learning: store.listLearning(),
      skillRevisions: store.listSkillRevisions(),
      schedules: store.listSchedules(),
      runs: store.listRuns(),
      gateways: store.listGatewayConnections(),
      device: await collectDeviceReadiness(),
      localGatewayState: readLocalGatewayState(),
    })
  } finally {
    store.close()
  }
}

async function localAgentPlanPreview(
  request: AgentPlanPreviewRequest,
  options: IntentExecutionOptions,
): Promise<AgentPlanPreview> {
  if (options.agentPlanPreview) return options.agentPlanPreview(request)
  return createAgentPlanPreview({ ...request, device: await collectDeviceReadiness() })
}

function knownWorkspaceID(value: string, projects: Project.Info[]): string | undefined {
  const normalized = value.toLowerCase()
  const matches = projects.filter((project) => {
    const id = project.id.toLowerCase()
    return new RegExp(`(?:^|[^a-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9_-])`).test(normalized)
  })
  return matches.length === 1 ? matches[0].id : undefined
}

async function localWorkspaceProjects(options: IntentExecutionOptions): Promise<Project.Info[]> {
  if (options.workspaceProjects) return options.workspaceProjects()
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(Project.Service.use((service) => service.list()))
}

async function localPermissionExplanation(
  category: InspectablePermissionCategory,
  options: IntentExecutionOptions,
): Promise<string> {
  if (options.permissionExplanation) return options.permissionExplanation(category)
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Config } = await import("@/config/config")
  return AppRuntime.runPromise(
    Config.Service.use((config) => config.get()).pipe(
      Effect.map((config) => {
        const project = config.permission ? Permission.fromConfig(config.permission) : []
        return formatPermissionInspection(Permission.explainDecision({ permission: category, pattern: "*", project }))
      }),
    ),
  )
}

/**
 * Executes only a literal allowlist of local formatters. The two narrow mutations require
 * a separate explicit confirmation. It never shells out, loads plugins, calls a
 * model/provider, validates keys, changes vault/route state, or forwards the user
 * message to another subsystem.
 */
export async function executeLocalIntent(
  value: string,
  options: IntentExecutionOptions = {},
): Promise<IntentExecution> {
  const inspection = inspectIntent(value)
  if (inspection.confidence !== "high") {
    return blockedExecution(inspection, "Only a bounded, high-confidence read-only local intent may be executed.")
  }
  if (inspection.category === "api-status") {
    if (inspection.command === "list") {
      const status = getApiVaultStatus()
      return {
        ...inspection,
        execution: "executed",
        result: formatApiVaultList({
          vaultPath: apiVaultKeyPath(),
          autoRotate: status.autoRotate,
          budget: getApiUsageBudget(),
          rows: apiVaultRows(),
        }),
      }
    }
    if (inspection.command === "budget") {
      return { ...inspection, execution: "executed", result: formatApiUsageBudget(getApiUsageBudget()) }
    }
    if (inspection.command === "readiness") {
      const status = getApiVaultStatus()
      return {
        ...inspection,
        execution: "executed",
        result: formatApiReadiness({
          autoRotate: status.autoRotate,
          budget: getApiUsageBudget(),
          rows: apiVaultRows(),
        }),
      }
    }
  }
  if (inspection.category === "memory") {
    if (inspection.command === "status") {
      return {
        ...inspection,
        execution: "executed",
        result: formatMemoryStatus(memoryStatus(options.memoryStateDirectory), "table"),
      }
    }
    if (inspection.command === "list") {
      return {
        ...inspection,
        execution: "executed",
        result: formatMemoryList(listLocalMemories({ stateDirectory: options.memoryStateDirectory }), "table"),
      }
    }
    if (inspection.command === "show") {
      const id = requestedMemoryID(value)
      if (!Number.isSafeInteger(id) || !id || id < 1)
        return blockedExecution(inspection, "State exactly one positive local memory ID to show; no entry was read.")
      const entry = getLocalMemory({ id, stateDirectory: options.memoryStateDirectory })
      return entry
        ? { ...inspection, execution: "executed", result: formatMemoryList([entry], "table") }
        : blockedExecution(inspection, `No local memory entry exists for ID ${id}; no storage was created or changed.`)
    }
  }
  if (inspection.category === "agent-status" && inspection.command === "status") {
    if (hasUnsafeAgentCapabilityStatusWording(value)) {
      return blockedExecution(
        inspection,
        "Agent capability execution accepts status-only wording; no creation, approval, enablement, runtime, credential, or remote request was run.",
      )
    }
    const section = requestedAgentCapabilitySection(value)
    if (section === "ambiguous") {
      return blockedExecution(
        inspection,
        "Name at most one capability area—learning, scheduler, subagents, or gateway—or request overall agent status.",
      )
    }
    try {
      return {
        ...inspection,
        execution: "executed",
        result: formatAgentCapabilityStatus(await localAgentCapabilityStatus(options), "table", section),
      }
    } catch {
      return blockedExecution(
        inspection,
        "The local agent capability metadata could not be read; no runtime, schedule, agent, gateway, or configuration state changed.",
      )
    }
  }
  if (inspection.category === "agent-plan-preview" && inspection.command === "plan preview") {
    if (hasUnsafeAgentPlanPreviewWording(value)) {
      return blockedExecution(
        inspection,
        "Plan preview accepts only an explicit existing role and bounded local policy wording; no run, agent, queue, schedule, credential, remote request, or persistence was started.",
      )
    }
    const request = requestedAgentPlanPreview(value)
    if (request === "ambiguous") {
      return blockedExecution(
        inspection,
        "Name exactly one supported role and use at most one bounded children, parallel, and budget value; children are 0–12, parallel is 1–12, and parallel cannot exceed lead plus children.",
      )
    }
    try {
      return {
        ...inspection,
        execution: "executed",
        result: formatAgentPlanPreview(await localAgentPlanPreview(request, options), "table"),
      }
    } catch {
      return blockedExecution(
        inspection,
        "The bounded local plan preview could not be prepared; no run, agent, queue, schedule, source, session, provider, or remote state changed.",
      )
    }
  }
  if (inspection.category === "agent-role") {
    if (inspection.command === "role list")
      return { ...inspection, execution: "executed", result: formatSpecialistRoles("table") }
    if (inspection.command === "role show") {
      const role = roleNamedIn(value)
      return role
        ? { ...inspection, execution: "executed", result: formatSpecialistRole(role, "table") }
        : blockedExecution(inspection, "Name one supported role: planner, coder, reviewer, or tester.")
    }
  }
  if (inspection.category === "permission" && inspection.command === "explain") {
    const category = requestedPermissionCategory(value)
    if (!category || hasUnsafePermissionExplanationWording(value)) {
      return blockedExecution(
        inspection,
        "Name exactly one safe permission category (bash, edit, read, webfetch, or question) without a command, path, rule, or edit request.",
      )
    }
    try {
      return { ...inspection, execution: "executed", result: await localPermissionExplanation(category, options) }
    } catch {
      return blockedExecution(
        inspection,
        "The local fixed-category permission explanation could not be read; no rule or configuration changed.",
      )
    }
  }
  if (
    inspection.category === "translation" &&
    (inspection.command === "plan" || inspection.command === "confirmed report")
  ) {
    const languages = requestedTranslationLanguages(value)
    if (!languages) {
      return blockedExecution(
        inspection,
        "State exactly two distinct supported languages: typescript, javascript, python, php, or go.",
      )
    }
    if (inspection.command === "confirmed report" && !options.confirmLocal) {
      return blockedExecution(
        inspection,
        "Writing the fixed local translation metadata report requires --confirm-local. No report was created.",
      )
    }
    if (inspection.command === "confirmed report" && /\b(?:to|at|path)\s+\S+\.json\b/i.test(value)) {
      return blockedExecution(
        inspection,
        `The confirmed report uses only the fixed ${CONFIRMED_TRANSLATION_REPORT} filename; no user-supplied path is accepted.`,
      )
    }
    try {
      const root = options.translationRoot ?? process.cwd()
      const collected = await collectTranslationFiles({ root, scope: ".", language: languages.source, maxFiles: 50 })
      const plan = createTranslationPlan({
        source: languages.source,
        target: languages.target,
        scope: ".",
        files: collected.files,
        truncated: collected.truncated,
      })
      if (inspection.command === "confirmed report") {
        const report = await writeTranslationReport({ root, output: CONFIRMED_TRANSLATION_REPORT, plan })
        return {
          ...inspection,
          execution: "executed",
          result: `Created ${report} with translation-plan metadata only. No source content was read, no model/provider was called, and no code was transformed.`,
        }
      }
      return {
        ...inspection,
        execution: "executed",
        result: formatTranslationPlan(plan, "table"),
      }
    } catch {
      return blockedExecution(
        inspection,
        inspection.command === "confirmed report"
          ? `The fixed ${CONFIRMED_TRANSLATION_REPORT} report could not be created; existing files are never overwritten.`
          : "The current project could not be inventoried within the bounded local plan.",
      )
    }
  }
  if (inspection.category === "local-model" && inspection.command === "local recommendations") {
    const config = getDeviceConfig()
    return {
      ...inspection,
      execution: "executed",
      result: /\bcatalog\b/i.test(value)
        ? formatLocalModelCatalog(config)
        : formatLocalModelRecommendations(config).join(EOL),
    }
  }
  if (inspection.category === "model-route" && inspection.command === "route preview") {
    const alias = requestedKnownModelAlias(value)
    if (!alias)
      return blockedExecution(inspection, "Name one supported route alias: deepseek, llama 3.1, gemini, or gpt-4.")
    return {
      ...inspection,
      execution: "executed",
      result: formatApiRoutePreview({ model: alias, routes: routeModel(alias), rows: apiVaultPublicRows() }),
    }
  }
  if (inspection.category === "device" && inspection.command === "readiness") {
    const readiness = await collectDeviceReadiness()
    return { ...inspection, execution: "executed", result: formatDeviceReadiness(readiness, "table") }
  }
  if (inspection.category === "instructions") {
    if (inspection.command === "explain")
      return { ...inspection, execution: "executed", result: formatInstructionExplanation() }
    if (inspection.command === "status") {
      const directory = process.cwd()
      return { ...inspection, execution: "executed", result: formatInstructionStatus(directory, directory) }
    }
  }
  if (inspection.category === "workspace" && (inspection.command === "list" || inspection.command === "show")) {
    if (hasUnsafeWorkspaceExecutionWording(value)) {
      return blockedExecution(
        inspection,
        "Workspace execution accepts only bounded known-project list or one exact ID show wording; no path, selection, shell, session, or write request was run.",
      )
    }
    try {
      const projects = await localWorkspaceProjects(options)
      if (inspection.command === "list") {
        return { ...inspection, execution: "executed", result: formatWorkspaceList(projects, "table") }
      }
      const projectID = knownWorkspaceID(value, projects)
      if (!projectID) {
        return blockedExecution(
          inspection,
          "State exactly one existing normalized workspace ID from the local known-project list; no directory was scanned, selected, or changed.",
        )
      }
      const project = projects.find((item) => item.id === projectID)
      return project
        ? { ...inspection, execution: "executed", result: formatWorkspaceDetail(project, "table") }
        : blockedExecution(
            inspection,
            "The requested known workspace was unavailable; no directory was scanned or changed.",
          )
    } catch {
      return blockedExecution(
        inspection,
        "The local known-project registry could not be read; no discovery scan, selection, or state change occurred.",
      )
    }
  }
  if (inspection.category === "workspace" && inspection.command === "selected") {
    return { ...inspection, execution: "executed", result: formatWorkspaceSelection(await readWorkspaceSelection()) }
  }
  if (inspection.category === "workspace-mutation" && inspection.command === "clear selection bookmark") {
    if (!options.confirmLocal) {
      return blockedExecution(
        inspection,
        "Clearing the local workspace selection bookmark requires --confirm-local. No mutation was performed.",
      )
    }
    const cleared = await clearWorkspaceSelection(options.workspaceSelectionDirectory)
    return {
      ...inspection,
      execution: "executed",
      result: cleared
        ? "Cleared the local workspace selection bookmark. This did not change the shell directory, project/source/configuration/session state, provider/vault/model state, or any remote resource."
        : "No local workspace selection bookmark existed. Nothing was changed.",
    }
  }
  return blockedExecution(
    inspection,
    "This suggested route is not in the explicit read-only execution allowlist and was not run.",
  )
}

export function formatIntentExecution(result: IntentExecution, format: "table" | "json"): string {
  if (format === "json") return JSON.stringify(result, null, 2)
  const confirmedMutation =
    result.execution === "executed" &&
    (result.category === "workspace-mutation" ||
      (result.category === "translation" && result.command === "confirmed report"))
  const lines = [
    `Category: ${result.category}`,
    `Suggested local route: ${result.plugin && result.command ? `${result.plugin}:${result.command}` : "none"}`,
    `Confidence: ${result.confidence}`,
    `Execution: ${result.execution === "executed" ? (confirmedMutation ? "completed locally (confirmed mutation)" : "completed locally (read-only)") : "blocked"}`,
  ]
  if (result.execution === "executed" && result.result) lines.push("Result:", result.result)
  else if (result.reason) lines.push(`Reason: ${result.reason}`)
  lines.push(
    result.category === "workspace-mutation" && result.execution === "executed"
      ? "Execution boundary: only the explicitly confirmed local workspace selection bookmark was cleared; no model call, plugin load, shell execution, remote request, key check, route selection, or other persistent preference change occurred."
      : result.category === "translation" && result.command === "confirmed report" && result.execution === "executed"
        ? `Execution boundary: only the explicitly confirmed new ${CONFIRMED_TRANSLATION_REPORT} metadata report was created; no source content was read, model/provider called, code transformed, existing file overwritten, shell command executed, or remote request made.`
        : result.category === "agent-plan-preview" && result.execution === "executed"
          ? "Execution boundary: only a bounded local policy preview was formatted from observed device signals; no run, agent, queue, schedule, source, session, provider, credential, remote request, or persistent state changed."
          : "Execution boundary: no model call, plugin load, shell execution, remote request, key check, write, route selection, or persistent preference occurred.",
  )
  return lines.join(EOL)
}

export const IntentCommand = cmd({
  command: "intent <message..>",
  describe:
    "inspect a bounded Hinglish/English intent locally; mutations require explicit execution and confirmation flags",
  builder: (yargs) =>
    yargs
      .positional("message", {
        type: "string",
        array: true,
        demandOption: true,
        describe: "non-sensitive request to inspect",
      })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" })
      .option("execute-local", {
        type: "boolean",
        default: false,
        describe: "explicitly run a hard-coded local allowlist; mutations still require --confirm-local",
      })
      .option("confirm-local", {
        type: "boolean",
        default: false,
        describe: "separately confirm the one supported local mutation; has no effect without --execute-local",
      }),
  async handler(args) {
    const message = args.message.join(" ")
    if (args.executeLocal) {
      process.stdout.write(
        formatIntentExecution(
          await executeLocalIntent(message, { confirmLocal: args.confirmLocal }),
          args.format === "json" ? "json" : "table",
        ) + EOL,
      )
      return
    }
    process.stdout.write(
      formatIntentInspection(inspectIntent(message), args.format === "json" ? "json" : "table") + EOL,
    )
  },
})
