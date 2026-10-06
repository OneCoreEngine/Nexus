import type { Argv } from "yargs"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cmd } from "./cmd"
import { runtimeTempDirectory } from "@nexus-ai/core/platform"

const execFileAsync = promisify(execFile)

type DevArgs = { path: string; team?: boolean; solo?: boolean; apply?: boolean; zen?: boolean; limit?: number }

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`)
  return value
}

async function loadCore() {
  return import("@nexus/termux-core")
}

function printAnalysis(result: {
  summary: string
  bugs: Array<{ severity: string; type: string; file: string; line: number; description: string }>
}) {
  process.stdout.write(`${result.summary}\n`)
  if (result.bugs.length === 0) {
    process.stdout.write("No static issues detected.\n")
    return
  }
  for (const bug of result.bugs) {
    process.stdout.write(`${bug.severity.toUpperCase()} ${bug.type} ${bug.file}:${bug.line} — ${bug.description}\n`)
  }
}

const ReadCommand = cmd({
  command: "read <target>",
  describe: "clone or scan a repository and show a fast summary",
  builder: (yargs: Argv) =>
    yargs.positional("target", { type: "string", describe: "local path or GitHub repository URL" }),
  async handler(args) {
    const target = requiredString(args.target, "target")
    let root = resolve(target)
    if (/^https?:\/\//i.test(target)) {
      const name = basename(new URL(target).pathname.replace(/\/$/, "")) || "repository"
      const directory = await mkdtemp(join(tmpdir(), "nexus-repo-"))
      root = join(directory, name.replace(/\.git$/, ""))
      await execFileAsync("git", ["clone", "--depth", "1", target, root], {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      })
    }
    const { SeniorDevAgent } = await loadCore()
    const result = await new SeniorDevAgent().analyze(root)
    process.stdout.write(`Repository: ${root}\nFiles: ${result.files.length}\n`)
    printAnalysis(result)
  },
})

const AnalyzeCommand = cmd({
  command: "analyze <path>",
  describe: "scan a repository for likely bugs and security risks",
  builder: (yargs: Argv) => yargs.positional("path", { type: "string", describe: "repository or file path" }),
  async handler(args) {
    const path = requiredString(args.path, "path")
    const { SeniorDevAgent } = await loadCore()
    printAnalysis(await new SeniorDevAgent().analyze(path))
  },
})

const FixCommand = cmd({
  command: "fix <path>",
  describe: "analyze a repository and apply only high-confidence safe fixes (analysis-only otherwise)",
  builder: (yargs: Argv) =>
    yargs
      .positional("path", { type: "string", describe: "repository path" })
      .option("team", { type: "boolean", default: false, describe: "force Manager → Lead → Worker → Checker mode" })
      .option("solo", { type: "boolean", default: false, describe: "force Senior Dev solo mode" })
      .option("zen", {
        type: "boolean",
        default: false,
        describe: "use the local zen bridge model to generate precise line replacements",
      })
      .option("limit", { type: "number", default: 6, describe: "maximum bugs to hand to the zen model per run" })
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "allow safe automatic replacements when available",
      }),
  async handler(args) {
    const path = requiredString(args.path, "path")
    const core = await loadCore()
    if (args.team && args.solo) throw new Error("Choose only one of --team or --solo.")
    if (args.team) {
      const result = await new core.TeamHierarchy().manager.runProject(`fix bugs in ${path}`, path, {
        forceTeam: true,
        onProgress: (status) => {
          process.stdout.write(`Progress: ${status.status} (${status.progress}%)\n`)
        },
      })
      process.stdout.write(`${result.summary}\nTask ID: ${result.taskId}\n`)
      return
    }
    if (args.zen) {
      const analysis = await new core.SeniorDevAgent().analyze(path)
      process.stdout.write(`${analysis.summary}\n`)
      if (analysis.bugs.length === 0) {
        process.stdout.write("No static issues detected; nothing to send to the zen model.\n")
        return
      }
      const { ZenFixer } = await import("./dev/zen-fix")
      const zen = new ZenFixer()
      const rank = (b: { severity: string }) => (b.severity === "high" ? 0 : b.severity === "medium" ? 1 : 2)
      const targets = [...analysis.bugs].sort((a, b) => rank(a) - rank(b) || a.line - b.line).slice(0, args.limit)
      let applied = 0
      let bridgeFlat = 0
      for (const bug of targets) {
        const fullPath = resolve(path, bug.file)
        const result = await zen.fixBug({ ...bug, file: fullPath }, { dryRun: !args.apply })
        const status = result.status.toUpperCase().padEnd(22)
        process.stdout.write(`${status} ${bug.file}:${bug.line} — ${result.detail}\n`)
        if (result.status === "model-request-failed" && result.detail.includes("zen-bridge")) bridgeFlat++
        if (args.apply && result.status === "applied") {
          const tests = await zen.verify(resolve(path))
          process.stdout.write(`  Verification: ${tests.passed ? "passed" : "failed"}\n`)
          if (!tests.passed) {
            try {
              await writeFile(fullPath, await readFile(`${fullPath}.zenbak`, "utf8"), "utf8")
              process.stdout.write("  Reverted: verification failed.\n")
            } catch {
              process.stdout.write("  Revert failed: restore from <file>.zenbak manually.\n")
            }
            await rm(`${fullPath}.zenbak`, { force: true })
            continue
          }
          applied++
        }
        await rm(`${fullPath}.zenbak`, { force: true })
      }
      if (bridgeFlat === targets.length && targets.length > 0) {
        process.stdout.write(
          "zen-bridge is not reachable — launch the 'nexus' command once to auto-start it, then retry.\n",
        )
      } else if (args.apply) {
        process.stdout.write(
          `${applied} fix(es) written and verified; ${targets.length - applied} reverted, skipped, or failed.\n`,
        )
      } else {
        process.stdout.write(
          `Dry run: ${targets.length} candidate fix(es) generated. Rerun with --apply to write them.\n`,
        )
      }
      process.stdout.write("Model-written edits — review the diff with 'git diff' before relying on them.\n")
      return
    }
    const result = await new core.SeniorDevAgent().fix(path, { dryRun: !args.apply, runTests: true })
    process.stdout.write(`${result.summary}\n`)
    if (result.fixes && result.fixes.fixed.length === 0) {
      process.stdout.write(
        "Note: no automatic fix was applied — the local detector only reports likely issues and is not a model.\n",
      )
    }
    if (result.tests)
      process.stdout.write(
        `Verification: ${result.tests.passed ? "passed" : "failed"}${result.tests.command ? ` (${result.tests.command})` : ""}\n`,
      )
    for (const item of result.fixes?.skipped ?? [])
      process.stdout.write(`Skipped ${item.bug.file}:${item.bug.line} — ${item.reason}\n`)
  },
})

const ReviewCommand = cmd({
  command: "review <path>",
  describe: "review a repository without applying changes",
  builder: (yargs: Argv) => yargs.positional("path", { type: "string", describe: "repository path" }),
  async handler(args) {
    const path = requiredString(args.path, "path")
    const { SeniorDevAgent } = await loadCore()
    printAnalysis(await new SeniorDevAgent().analyze(path))
  },
})

const OptimizeCommand = cmd({
  command: "optimize <path>",
  describe: "report likely performance issues without changing code",
  builder: (yargs: Argv) => yargs.positional("path", { type: "string", describe: "repository path" }),
  async handler(args) {
    const path = requiredString(args.path, "path")
    const { SeniorDevAgent } = await loadCore()
    const result = await new SeniorDevAgent().analyze(path)
    const performance = result.bugs.filter((bug) => bug.type === "performance")
    printAnalysis({ summary: `Performance review: ${performance.length} potential issue(s).`, bugs: performance })
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show active hierarchy and liaison task status files",
  builder: (yargs: Argv) => yargs,
  async handler() {
    const tempRoot = runtimeTempDirectory()
    const roots = [join(tempRoot, "nexus", "teams"), join(tempRoot, "nexus", "liaison")]
    let found = 0
    for (const root of roots) {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          const statusPath = entry.isDirectory() ? join(root, entry.name, "status.json") : join(root, entry.name)
          try {
            const value = JSON.parse(await readFile(statusPath, "utf8")) as {
              taskId?: string
              status?: string
              progress?: number
            }
            process.stdout.write(
              `${value.taskId ?? entry.name}\t${value.status ?? "unknown"}\t${value.progress ?? 0}%\n`,
            )
            found += 1
          } catch {
            // Ignore incomplete or unrelated status files.
          }
        }
      } catch {
        // Status directories are optional and may not exist yet.
      }
    }
    if (found === 0) process.stdout.write("No active NEXUS dev tasks.\n")
  },
})

export const DevCommand = cmd({
  command: "dev",
  describe: "Senior Dev and hierarchical repository workflows",
  builder: (yargs: Argv) =>
    yargs
      .command(ReadCommand)
      .command(AnalyzeCommand)
      .command(FixCommand)
      .command(ReviewCommand)
      .command(OptimizeCommand)
      .command(StatusCommand)
      .demandCommand(),
  async handler() {},
})
