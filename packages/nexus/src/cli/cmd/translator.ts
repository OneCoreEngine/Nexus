import fs from "node:fs/promises"
import path from "node:path"
import { EOL } from "node:os"
import { Effect } from "effect"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

export const translationLanguages = ["typescript", "javascript", "python", "php", "go"] as const
export type TranslationLanguage = (typeof translationLanguages)[number]

const languageExtensions: Record<TranslationLanguage, ReadonlySet<string>> = {
  typescript: new Set([".ts", ".tsx", ".mts", ".cts"]),
  javascript: new Set([".js", ".jsx", ".mjs", ".cjs"]),
  python: new Set([".py"]),
  php: new Set([".php"]),
  go: new Set([".go"]),
}

const ignoredDirectories = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage"])

export type TranslationPlan = {
  source: TranslationLanguage
  target: TranslationLanguage
  scope: string
  files: string[]
  truncated: boolean
  manualReview: string[]
}

function safeDisplay(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export async function collectTranslationFiles(input: {
  root: string
  scope: string
  language: TranslationLanguage
  maxFiles: number
}): Promise<{ files: string[]; truncated: boolean }> {
  const root = path.resolve(input.root)
  const scope = path.resolve(root, input.scope)
  if (!isPathWithin(root, scope)) throw new Error("Translation scope must stay inside the current project")

  const extensions = languageExtensions[input.language]
  const files: string[] = []
  let truncated = false

  async function visit(directory: string): Promise<void> {
    if (files.length >= input.maxFiles) {
      truncated = true
      return
    }
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= input.maxFiles) {
        truncated = true
        return
      }
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(absolute)
        continue
      }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue
      files.push(path.relative(root, absolute))
    }
  }

  const stat = await fs.lstat(scope)
  if (stat.isSymbolicLink()) throw new Error("Translation scope must not be a symbolic link")
  if (stat.isDirectory()) await visit(scope)
  else if (stat.isFile() && extensions.has(path.extname(scope).toLowerCase())) files.push(path.relative(root, scope))
  return { files, truncated }
}

export function createTranslationPlan(input: {
  source: TranslationLanguage
  target: TranslationLanguage
  scope: string
  files: string[]
  truncated: boolean
}): TranslationPlan {
  return {
    source: input.source,
    target: input.target,
    scope: safeDisplay(input.scope) || ".",
    files: input.files.map(safeDisplay).filter(Boolean),
    truncated: input.truncated,
    manualReview: [
      "Review each translated file before applying it to the project.",
      "Verify dependencies, framework conventions, tests, and generated configuration manually.",
      "This command does not read file contents, call a model, or write translated output.",
    ],
  }
}

export function formatTranslationPlan(plan: TranslationPlan, format: "table" | "json"): string {
  if (format === "json") return JSON.stringify(plan, null, 2)
  const lines = [
    "NEXUS Translation Plan (manual review required; not executed)",
    `Direction: ${plan.source} → ${plan.target}`,
    `Scope: ${plan.scope}`,
    `Eligible files: ${plan.files.length}${plan.truncated ? " (bounded list; additional matches not listed)" : ""}`,
  ]
  for (const file of plan.files.slice(0, 30)) lines.push(`  • ${file}`)
  if (plan.files.length > 30) lines.push(`  … and ${plan.files.length - 30} more eligible file(s)`)
  lines.push("Manual review:")
  for (const item of plan.manualReview) lines.push(`  • ${item}`)
  return lines.join(EOL)
}

export async function writeTranslationReport(input: {
  root: string
  output: string
  plan: TranslationPlan
}): Promise<string> {
  const root = await fs.realpath(input.root)
  const output = path.resolve(root, input.output)
  if (!isPathWithin(root, output)) throw new Error("Translation report path must stay inside the current project")
  if (path.extname(output).toLowerCase() !== ".json") throw new Error("Translation report must use a .json filename")

  const parent = path.dirname(output)
  await fs.mkdir(parent, { recursive: true })
  const actualParent = await fs.realpath(parent)
  if (!isPathWithin(root, actualParent)) throw new Error("Translation report path must stay inside the current project")

  await fs.writeFile(output, JSON.stringify(input.plan, null, 2) + "\n", { encoding: "utf8", flag: "wx" })
  return path.relative(root, output)
}

export const TranslatorPlanCommand = effectCmd({
  command: "plan [scope]",
  describe: "create a bounded local translation plan without reading contents, calling a model, or writing files",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("scope", {
        describe: "file or directory inside the current project",
        type: "string",
        default: ".",
      })
      .option("from", {
        describe: "source language",
        type: "string",
        choices: translationLanguages,
        demandOption: true,
      })
      .option("to", {
        describe: "target language for manual review planning",
        type: "string",
        choices: translationLanguages,
        demandOption: true,
      })
      .option("max-files", {
        describe: "maximum files to inventory (1–100; default 50)",
        type: "number",
        default: 50,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
      .option("report", {
        describe: "optional project-contained .json manual-review report to create",
        type: "string",
      })
      .option("confirm", {
        describe: "explicitly confirm creating a new manual-review report file",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.translator.plan")(function* (args) {
    if (!args.from || !args.to) return yield* fail("Both --from and --to are required")
    const from = args.from
    const to = args.to
    const maxFiles = args.maxFiles ?? 50
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
      return yield* fail("--max-files must be an integer from 1 to 100")
    }
    if (from === to) return yield* fail("--from and --to must be different languages")

    const root = process.cwd()
    const scope = args.scope ?? "."
    const collected = yield* Effect.tryPromise({
      try: () => collectTranslationFiles({ root, scope, language: from, maxFiles }),
      catch: (error) => new CliError({ message: `Unable to scan translation files: ${String(error)}` }),
    })
    const relativeScope = path.relative(root, path.resolve(root, scope)) || "."
    const plan = createTranslationPlan({
      source: from,
      target: to,
      scope: relativeScope,
      files: collected.files,
      truncated: collected.truncated,
    })
    if (args.report) {
      if (!args.confirm) return yield* fail("Creating a translation report requires --confirm")
      const reportPath = yield* Effect.tryPromise({
        try: () => writeTranslationReport({ root, output: args.report!, plan }),
        catch: (error) => new CliError({ message: `Unable to write translation report: ${String(error)}` }),
      })
      process.stdout.write(
        `Manual-review report created at ${reportPath}. It contains plan metadata only; no source was read or translated.${EOL}`,
      )
    }
    process.stdout.write(formatTranslationPlan(plan, args.format ?? "table") + EOL)
  }),
})

export const TranslatorCommand = cmd({
  command: "translator",
  describe: "prepare bounded local translation plans for manual review",
  builder: (yargs) => yargs.command(TranslatorPlanCommand).demandCommand(),
  async handler() {},
})
