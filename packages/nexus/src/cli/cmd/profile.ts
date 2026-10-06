import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import type { Argv } from "yargs"
import { Global } from "@nexus-ai/core/global"
import {
  TASK_PROFILES,
  RUNTIME_PROFILES,
  currentTaskProfile,
  isTermuxRuntime,
  resolveRuntimeProfile,
  setTaskProfile,
  type RuntimeProfileName,
  type TaskProfileName,
} from "@/runtime/task-profile"
import { loadApiVault } from "../../api/ApiVault"
import { SKILL_PROMPT_BUDGET_CHARS } from "../../skill"

const choices = Object.keys(TASK_PROFILES) as TaskProfileName[]

export const ProfileCommand = {
  command: "profile <command>",
  describe: "view or set a bounded task-execution profile",
  builder: (yargs: import("yargs").Argv) =>
    yargs
      .command({
        command: "list",
        describe: "list available profiles",
        handler: () => {
          for (const profile of Object.values(TASK_PROFILES)) {
            console.log(
              `${profile.name.padEnd(9)} ${profile.label} — ${profile.preference}, ${profile.outputBudget} output, max ${profile.maxParallel} parallel`,
            )
          }
        },
      })
      .command({
        command: "show",
        describe: "show the active profile",
        handler: () => console.log(JSON.stringify(currentTaskProfile(), null, 2)),
      })
      .command(
        "set <name>",
        "set the default profile; manual model and task settings still override it",
        (command) => command.positional("name", { choices, type: "string" }),
        async (args) => {
          const profile = await setTaskProfile(args.name as TaskProfileName)
          console.log(`Task profile set to ${profile.label}.`)
        },
      )
      .command({
        command: "runtime",
        describe: "show the resolved runtime profile and boot composition",
        builder: (command: Argv) =>
          command
            .option("profile", { type: "string", describe: "override the profile for this printout" })
            .option("json", { type: "boolean", default: false, describe: "print machine-readable output" }),
        handler: async (args: { profile?: string; json?: boolean }) => {
          const result = dumpRuntimeProfile(args.profile)
          if (args.json) {
            console.log(JSON.stringify(result, null, 2))
            return
          }
          const definition = RUNTIME_PROFILES[result.profile]
          console.log(`Runtime profile: ${result.profile} (${result.reason})`)
          console.log(`  ${definition.description}`)
          console.log(`  Autonomy: ${definition.autonomy}`)
          console.log(
            `Runtime: ${result.runtime.platform}${result.runtime.termux ? " (Termux)" : ""} ${result.runtime.node}`,
          )
          console.log(`Skill prompt budget: ${result.skillPromptBudgetChars} chars`)
          console.log(
            `Vault: ${result.vault.providers} provider(s), max ${result.vault.maxKeysPerProvider} key(s) each${result.vault.singleKey ? " (single-key)" : " (MULTI-KEY PRESENT)"}`,
          )
        },
      })
      .demandCommand(1),
  handler: () => undefined,
}

function configRuntimeProfile(): string | undefined {
  for (const file of ["nexus.jsonc", "nexus.json", "config.json"]) {
    const full = path.join(Global.Path.config, file)
    if (!existsSync(full)) continue
    try {
      const data: unknown = parse(readFileSync(full, "utf8"))
      if (data && typeof data === "object" && "profile" in data && typeof data.profile === "string") {
        return data.profile
      }
      continue
    } catch {
      continue
    }
  }
  return undefined
}

function vaultSummary() {
  try {
    const vault = loadApiVault()
    const providers = Object.keys(vault.providers)
    const maxKeys = providers.reduce((max, id) => Math.max(max, vault.providers[id].length), 0)
    return { providers: providers.length, maxKeysPerProvider: maxKeys, singleKey: maxKeys <= 1 }
  } catch {
    return { providers: 0, maxKeysPerProvider: 0, singleKey: true }
  }
}

export interface RuntimeProfileDump {
  profile: RuntimeProfileName
  reason: string
  runtime: { platform: string; termux: boolean; node: string }
  skillPromptBudgetChars: number
  vault: { providers: number; maxKeysPerProvider: number; singleKey: boolean }
}

export function dumpRuntimeProfile(explicit?: string): RuntimeProfileDump {
  const fromFlag = explicit && explicit.length > 0 ? explicit : undefined
  const fromEnv =
    process.env.NEXUS_PROFILE && process.env.NEXUS_PROFILE.length > 0 ? process.env.NEXUS_PROFILE : undefined
  const fromConfig = configRuntimeProfile()
  const chosen = fromFlag ?? fromEnv ?? fromConfig
  const profile = resolveRuntimeProfile(chosen)
  const source = fromFlag
    ? `--profile ${fromFlag}`
    : fromEnv
      ? "NEXUS_PROFILE env"
      : fromConfig
        ? `nexus.json profile: ${fromConfig}`
        : undefined
  const reason =
    source === undefined
      ? isTermuxRuntime()
        ? "auto-detected Termux"
        : "default web"
      : chosen !== undefined && !(chosen in RUNTIME_PROFILES)
        ? `${source} (unknown, fell back to ${profile})`
        : source
  return {
    profile,
    reason,
    runtime: { platform: process.platform, termux: isTermuxRuntime(), node: process.version },
    skillPromptBudgetChars: SKILL_PROMPT_BUDGET_CHARS,
    vault: vaultSummary(),
  }
}
