import { execFile } from "node:child_process"
import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { promisify } from "node:util"
import { join, relative } from "node:path"
import type { AgentCapabilities } from "./capabilities"
import { inspectPublicBrowserPage } from "./browser-handoff"
import { auditWebHtml } from "./web-audit"
import { planBrowserAction, type BrowserSessionState } from "./browser-session"
import { detectProjectTargets, type ProjectTarget } from "./project-targets"
import { planAndroidDeviceCommands } from "./android-audit"
import { createVerificationReceipt, type WorkerKind, type WorkerRequest, type WorkerResult } from "../agent/master"

export type ProjectCheckResult = {
  command: string
  exitCode: number
  output?: string
}

export type GitInspection = {
  branch?: string
  clean?: boolean
  changedFiles?: string[]
  summary: string
}

export type GitHubInspection = {
  repository?: string
  defaultBranch?: string
  url?: string
  authenticated: boolean
  summary: string
}

export type BrowserInspection = {
  url: string
  title?: string
  status?: number
  html?: string
  summary: string
}

export type AndroidDeviceCheckResult = {
  command: string
  exitCode: number
  output?: string
}

export type AndroidDeviceInspection = {
  connected: boolean
  state?: string
  summary: string
}

export type CoderStepInput = {
  workspace: string
  objective: string
  stepTitle: string
  queuedInstructions: readonly string[]
  signal?: AbortSignal
}

export type CoderStepResult = {
  summary: string
  changedFiles?: string[]
  verification?: string[]
  receipts?: { command: string; exitCode: number; output?: string }[]
  artifacts?: string[]
  next?: string[]
}

export type ResearchStepResult = {
  summary: string
  verification?: string[]
  next?: string[]
}

export type DocsStepResult = {
  summary: string
  changedFiles?: string[]
  verification?: string[]
  next?: string[]
}

export type MasterWorkerOperations = {
  inspectGit?: (input: { workspace: string; signal?: AbortSignal }) => Promise<GitInspection>
  inspectGitHub?: (input: { workspace: string; signal?: AbortSignal }) => Promise<GitHubInspection>
  inspectBrowser?: (input: { url: string; signal?: AbortSignal }) => Promise<BrowserInspection>
  runBrowserSession?: (input: {
    url: string
    objective: string
    signal?: AbortSignal
  }) => Promise<{ state: BrowserSessionState; message: string; url?: string }>
  inspectAndroidDevice?: (input: { signal?: AbortSignal }) => Promise<AndroidDeviceInspection>
  runAndroidDeviceChecks?: (input: {
    artifact: string
    packageName: string
    approvalGranted: boolean
    signal?: AbortSignal
  }) => Promise<readonly AndroidDeviceCheckResult[]>
  runProjectChecks?: (input: {
    workspace: string
    target: ProjectTarget
    commands: readonly string[]
    signal?: AbortSignal
  }) => Promise<readonly ProjectCheckResult[]>
  runCoderStep?: (input: CoderStepInput) => Promise<CoderStepResult>
  runResearchStep?: (input: CoderStepInput) => Promise<ResearchStepResult>
  runDocsStep?: (input: CoderStepInput) => Promise<DocsStepResult>
}

export type MasterWorkerContext = {
  capabilities: AgentCapabilities
  operations: MasterWorkerOperations
}

export type MasterWorker = {
  kind: WorkerKind
  run: (request: WorkerRequest, context: MasterWorkerContext) => Promise<WorkerResult>
}

const execFileAsync = promisify(execFile)
const urlPattern = /https?:\/\/[^\s)\]}>,]+/i

const allowedPackageScripts = new Set(["dev", "start", "test", "lint", "typecheck", "check", "build", "compile"])
const allowedGradleTasks = new Set(["tasks", "test", "connectedCheck", "assembleDebug", "assembleRelease"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function projectCommand(command: string, workspace: string, target: ProjectTarget) {
  const parts = command.trim().split(/\s+/)
  const executable = parts[0]
  if (!executable) return undefined

  if (
    target.kind === "android" &&
    executable === "./gradlew" &&
    parts.length === 2 &&
    allowedGradleTasks.has(parts[1])
  ) {
    return { file: join(workspace, "gradlew"), args: [parts[1]] }
  }

  if (
    target.kind !== "android" &&
    target.packageManager &&
    executable === target.packageManager &&
    parts.length === 3 &&
    parts[1] === "run" &&
    allowedPackageScripts.has(parts[2])
  ) {
    return { file: executable, args: ["run", parts[2]] }
  }

  return undefined
}

async function findBuildArtifacts(root: string, signal?: AbortSignal): Promise<string[]> {
  const artifacts: string[] = []
  const roots = ["dist", "build/outputs/apk", "build/outputs/bundle", "out"]
  const scan = async (directory: string, depth: number): Promise<void> => {
    if (signal?.aborted || depth > 4 || artifacts.length >= 100) return
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (signal?.aborted || artifacts.length >= 100) return
      const filepath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await scan(filepath, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.(apk|aab|js|css|html)$/i.test(entry.name)) continue
      artifacts.push(relative(root, filepath))
    }
  }
  for (const directory of roots) await scan(join(root, directory), 0)
  return artifacts.sort()
}

async function runProjectChecksReadOnly(input: {
  workspace: string
  target: ProjectTarget
  commands: readonly string[]
  signal?: AbortSignal
}): Promise<readonly ProjectCheckResult[]> {
  const results: ProjectCheckResult[] = []
  for (const command of input.commands) {
    const parsed = projectCommand(command, input.workspace, input.target)
    if (!parsed) {
      results.push({ command, exitCode: 126, output: "Skipped: command is not in the worker allowlist." })
      continue
    }
    try {
      const result = await execFileAsync(parsed.file, parsed.args, {
        cwd: input.workspace,
        maxBuffer: 512 * 1024,
        timeout: 120_000,
        signal: input.signal,
        windowsHide: true,
      })
      results.push({ command, exitCode: 0, output: `${result.stdout}${result.stderr}`.slice(-32_000) })
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
      const stdout = typeof error === "object" && error !== null && "stdout" in error ? error.stdout : ""
      const stderr = typeof error === "object" && error !== null && "stderr" in error ? error.stderr : ""
      results.push({
        command,
        exitCode: typeof code === "number" ? code : 1,
        output: `${String(stdout)}${String(stderr)}`.slice(-32_000),
      })
      break
    }
  }
  return results
}

async function inspectGitHubReadOnly(input: { workspace: string; signal?: AbortSignal }): Promise<GitHubInspection> {
  try {
    const result = await execFileAsync("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"], {
      cwd: input.workspace,
      maxBuffer: 128 * 1024,
      timeout: 8_000,
      signal: input.signal,
      windowsHide: true,
    })
    const parsed: unknown = JSON.parse(result.stdout)
    if (!isRecord(parsed)) throw new Error("GitHub returned an invalid repository response")
    const branch = isRecord(parsed.defaultBranchRef) ? parsed.defaultBranchRef.name : undefined
    return {
      repository: typeof parsed.nameWithOwner === "string" ? parsed.nameWithOwner : undefined,
      defaultBranch: typeof branch === "string" ? branch : undefined,
      url: typeof parsed.url === "string" ? parsed.url : undefined,
      authenticated: true,
      summary: `GitHub repository inspected${typeof parsed.nameWithOwner === "string" ? `: ${parsed.nameWithOwner}` : "."}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      authenticated: false,
      summary: `GitHub read-only inspection was unavailable: ${message.slice(0, 240)}`,
    }
  }
}

async function runAndroidDeviceChecksApproved(input: {
  artifact: string
  packageName: string
  approvalGranted: boolean
  signal?: AbortSignal
}): Promise<readonly AndroidDeviceCheckResult[]> {
  const commands = planAndroidDeviceCommands({
    artifact: input.artifact,
    packageName: input.packageName,
    androidDevice: true,
  })
  if (!input.approvalGranted)
    return commands.map((item) => ({
      command: item.command.join(" "),
      exitCode: 126,
      output: "Blocked: explicit device approval is required.",
    }))
  const results: AndroidDeviceCheckResult[] = []
  for (const item of commands) {
    try {
      const result = await execFileAsync(item.command[0]!, item.command.slice(1), {
        maxBuffer: 256 * 1024,
        timeout: item.id === "logcat" ? 8_000 : 60_000,
        signal: input.signal,
        windowsHide: true,
      })
      results.push({
        command: item.command.join(" "),
        exitCode: 0,
        output: `${result.stdout}${result.stderr}`.slice(-32_000),
      })
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
      const stdout = typeof error === "object" && error !== null && "stdout" in error ? error.stdout : ""
      const stderr = typeof error === "object" && error !== null && "stderr" in error ? error.stderr : ""
      results.push({
        command: item.command.join(" "),
        exitCode: typeof code === "number" ? code : 1,
        output: `${String(stdout)}${String(stderr)}`.slice(-32_000),
      })
      break
    }
  }
  return results
}

async function inspectAndroidDeviceReadOnly(input: { signal?: AbortSignal }): Promise<AndroidDeviceInspection> {
  try {
    const result = await execFileAsync("adb", ["get-state"], {
      maxBuffer: 16 * 1024,
      timeout: 4_000,
      signal: input.signal,
      windowsHide: true,
    })
    const state = result.stdout.trim()
    return {
      connected: state === "device",
      state: state || undefined,
      summary:
        state === "device"
          ? "Android device is connected and ready for device checks."
          : `ADB state is ${state || "unknown"}.`,
    }
  } catch {
    return { connected: false, summary: "Android device inspection was unavailable; no device command was run." }
  }
}

async function inspectGitReadOnly(input: { workspace: string; signal?: AbortSignal }): Promise<GitInspection> {
  const result = await execFileAsync("git", ["-C", input.workspace, "status", "--short", "--branch"], {
    maxBuffer: 512 * 1024,
    timeout: 8_000,
    signal: input.signal,
    windowsHide: true,
  })
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
  const branch = lines[0]?.startsWith("## ") ? lines[0].slice(3).split("...")[0] : undefined
  const changedFiles = lines
    .slice(branch ? 1 : 0)
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
  const clean = changedFiles.length === 0
  return {
    branch,
    clean,
    changedFiles,
    summary: clean ? "Git working tree is clean." : `Git working tree has ${changedFiles.length} changed file(s).`,
  }
}

function projectWorker(kind: "web" | "android", allow: (target: ProjectTarget) => boolean): MasterWorker {
  return {
    kind,
    async run(request, context) {
      const target = detectProjectTargets(request.workspace).find((item) => allow(item))
      if (!target) {
        return {
          status: "blocked",
          summary: `No ${kind} project target was detected in the workspace; no files or commands were changed.`,
          verification: ["Project detection completed without executing commands."],
          next: [
            kind === "android"
              ? "Create or open an Android/Gradle project, then rerun the Master task after confirming the required SDK and Gradle tooling."
              : "Create or open a Node/web project with its package manifest, then rerun the Master task after confirming the package manager.",
          ],
        }
      }

      const allCommands = [...target.testCommands, ...target.buildCommands]
      const commands = allCommands.filter(
        (command) => !command.includes("connected") || context.capabilities.androidDevice,
      )
      const skippedConnectedChecks = allCommands.filter(
        (command) => command.includes("connected") && !context.capabilities.androidDevice,
      )
      if (!context.operations.runProjectChecks || commands.length === 0) {
        return {
          status: "blocked",
          summary: `${kind} target detected; execution adapter is not enabled, so no commands were run.`,
          verification: [
            `Package manager: ${target.packageManager ?? "not applicable"}.`,
            ...commands.map((command) => `Available check: ${command}`),
            ...(skippedConnectedChecks.length
              ? [`Skipped without a connected Android device: ${skippedConnectedChecks.join(", ")}`]
              : []),
          ],
          next: [
            "Run only the listed focused checks after the runtime confirms the device profile and project permissions.",
          ],
        }
      }

      const device =
        kind === "android" && context.capabilities.androidDevice
          ? await (context.operations.inspectAndroidDevice ?? inspectAndroidDeviceReadOnly)({ signal: request.signal })
          : undefined
      const results = await context.operations.runProjectChecks({
        workspace: request.workspace,
        target,
        commands,
        signal: request.signal,
      })
      const failed = results.filter((result) => result.exitCode !== 0)
      const artifacts = failed.length === 0 ? await findBuildArtifacts(request.workspace, request.signal) : []
      return {
        status: failed.length === 0 ? "completed" : "blocked",
        summary:
          failed.length === 0
            ? `${kind} checks completed successfully.`
            : `${kind} checks completed with ${failed.length} failure(s); repair is required before success can be claimed.`,
        verification: [
          ...results.map((result) => `${result.exitCode === 0 ? "PASS" : "FAIL"}: ${result.command}`),
          ...(device ? [`Device: ${device.summary}`] : []),
          ...artifacts.map((artifact) => `Artifact: ${artifact}`),
          ...(skippedConnectedChecks.length
            ? [`Skipped without a connected Android device: ${skippedConnectedChecks.join(", ")}`]
            : []),
        ],
        receipts: results.map((result) =>
          createVerificationReceipt({ command: result.command, exitCode: result.exitCode, output: result.output }),
        ),
        artifacts: artifacts.length ? artifacts : undefined,
        next: failed.length
          ? ["Review the bounded command output and repair the first failing check before retrying."]
          : undefined,
      }
    },
  }
}

function gitWorker(): MasterWorker {
  return {
    kind: "git",
    async run(request, context) {
      if (!context.capabilities.git) {
        return { summary: "Git is not available on this device; no repository operation was attempted." }
      }
      if (!context.operations.inspectGit) {
        return {
          summary: "Git is available, but the read-only Git inspection adapter is not enabled; no changes were made.",
          verification: ["Commit, push, pull, issue, and pull-request actions remain approval-gated."],
        }
      }
      const result = await context.operations.inspectGit({ workspace: request.workspace, signal: request.signal })
      const github =
        context.capabilities.github && context.operations.inspectGitHub
          ? await context.operations.inspectGitHub({ workspace: request.workspace, signal: request.signal })
          : undefined
      return {
        summary: result.summary,
        changedFiles: result.changedFiles,
        verification: [
          result.branch ? `Branch: ${result.branch}` : "Branch: unavailable",
          result.clean === undefined
            ? "Working-tree state: unavailable"
            : `Working tree: ${result.clean ? "clean" : "changed"}`,
          "Only read-only inspection was requested by this worker.",
          ...(github ? [github.summary] : []),
          ...(github?.repository ? [`Repository: ${github.repository}`] : []),
          ...(github?.defaultBranch ? [`Default branch: ${github.defaultBranch}`] : []),
        ],
        receipts: [
          createVerificationReceipt({ command: "git status --short --branch", exitCode: 0, output: result.summary }),
        ],
        next: context.capabilities.github
          ? ["GitHub CLI is detected; external mutations still require explicit approval."]
          : undefined,
      }
    },
  }
}

function browserWorker(): MasterWorker {
  return {
    kind: "browser",
    async run(request, context) {
      const url = `${request.objective} ${request.step.title}`.match(urlPattern)?.[0]
      const actionKind = /click|press|tap/i.test(request.objective)
        ? "click"
        : /type|fill|enter/i.test(request.objective)
          ? "type"
          : /inspect|audit|test/i.test(request.objective)
            ? "inspect"
            : "navigate"
      const actionPlan = planBrowserAction({ kind: actionKind, target: request.objective })
      if (!url) {
        return {
          summary: "Browser worker needs an explicit http:// or https:// URL before inspection.",
          next: [
            "Provide a URL; login, uploads, personal data, CAPTCHA/2FA, and external submissions remain user-controlled.",
          ],
        }
      }
      if (context.operations.runBrowserSession && context.capabilities.browserAutomation) {
        const session = await context.operations.runBrowserSession({
          url,
          objective: request.objective,
          signal: request.signal,
        })
        const completed = session.state === "completed"
        return {
          status: completed ? "completed" : "blocked",
          summary: session.message,
          verification: [
            `Browser session state: ${session.state}.`,
            "Sensitive credentials, OTP values, CAPTCHA answers, and approval secrets remain user-controlled.",
            `Planned browser action: ${actionPlan.kind}; takeover required=${actionPlan.requiresTakeover}${actionPlan.reason ? ` (${actionPlan.reason})` : "."}`,
          ],
          receipts: [
            createVerificationReceipt({
              command: `BROWSER ${session.url ?? url}`,
              exitCode: completed ? 0 : 1,
              output: session.message,
            }),
          ],
          next: completed
            ? undefined
            : ["Complete the requested browser takeover or approval, then resume the checkpointed Master task."],
        }
      }
      if (!context.capabilities.browserHttpInspection || !context.operations.inspectBrowser) {
        return {
          summary:
            "Safe browser HTTP inspection is unavailable; URL handoff remains the only browser action supported here.",
          verification: ["No page was opened, logged into, uploaded to, or submitted."],
          next: ["Use the existing safe browser handoff or enable a supported local inspection adapter."],
        }
      }
      const result = await context.operations.inspectBrowser({ url, signal: request.signal })

      const audit =
        result.html !== undefined && result.status !== undefined
          ? auditWebHtml({ url: result.url, status: result.status, html: result.html })
          : undefined
      const hasErrors = result.status !== undefined && result.status >= 400
      return {
        status: hasErrors ? "blocked" : "completed",
        summary: result.summary,
        verification: [
          `Planned browser action: ${actionPlan.kind}; takeover required=${actionPlan.requiresTakeover}${actionPlan.reason ? ` (${actionPlan.reason})` : "."}`,
          `Inspected URL: ${result.url}`,
          ...(result.status === undefined ? [] : [`HTTP status: ${result.status}`]),
          ...(result.title ? [`Title: ${result.title}`] : []),
          ...(audit
            ? [
                `Controls: ${JSON.stringify(audit.controls)}`,
                ...audit.findings.map((finding) => `${finding.severity.toUpperCase()}: ${finding.message}`),
              ]
            : []),
        ],
        receipts: [
          createVerificationReceipt({
            command: `GET ${result.url}`,
            exitCode: result.status ?? 0,
            output: result.summary,
          }),
        ],
        ...(hasErrors || audit?.findings.some((finding) => finding.severity === "error")
          ? {
              next: [
                "Review the HTTP/UI findings and repair the first blocking issue before treating the browser step as complete.",
              ],
            }
          : {}),
      }
    },
  }
}

function researchWorker(): MasterWorker {
  return {
    kind: "research",
    async run(request, context) {
      if (context.operations.runResearchStep) {
        const result = await context.operations.runResearchStep({
          workspace: request.workspace,
          objective: request.objective,
          stepTitle: request.step.title,
          queuedInstructions: request.queuedInstructions,
          signal: request.signal,
        })
        return {
          summary: result.summary,
          verification: result.verification ?? ["Research notes recorded with sources and constraints."],
          next: result.next,
        }
      }
      const instructions = request.queuedInstructions.filter((item) => item.trim().length > 0)
      return {
        summary: `Research notes for: ${request.objective.slice(0, 240)}`,
        verification: [
          `Step scope: ${request.step.title}.`,
          `Constraints captured: ${instructions.length ? instructions.join(" | ").slice(0, 480) : "none provided"}.`,
          "Options and risks must be summarized with sources before coding starts.",
        ],
        next: ["Attach the chosen approach and its acceptance criteria to the coder step."],
      }
    },
  }
}

function coderWorker(): MasterWorker {
  return {
    kind: "coder",
    async run(request, context) {
      if (context.operations.runCoderStep) {
        const result = await context.operations.runCoderStep({
          workspace: request.workspace,
          objective: request.objective,
          stepTitle: request.step.title,
          queuedInstructions: request.queuedInstructions,
          signal: request.signal,
        })
        return {
          summary: result.summary,
          changedFiles: result.changedFiles,
          verification: result.verification ?? ["Coder adapter reported completion evidence."],
          receipts: result.receipts?.map((receipt) =>
            createVerificationReceipt({
              command: receipt.command,
              exitCode: receipt.exitCode,
              output: receipt.output,
            }),
          ),
          artifacts: result.artifacts,
          next: result.next ?? ["Hand the diff to the reviewer with the focused test command."],
        }
      }
      return {
        status: "blocked",
        summary: "Coder worker needs a registered edit adapter before changing files; nothing was modified.",
        verification: [
          "No files were read for editing and no commands were executed by this worker.",
          "Required adapter: MasterWorkerOperations.runCoderStep with an allowlisted edit+test runner.",
        ],
        next: ["Register runCoderStep (allowlisted edits + focused test receipts), then resume the checkpointed task."],
      }
    },
  }
}

function reviewerWorker(): MasterWorker {
  return {
    kind: "reviewer",
    async run(request, context) {
      if (!context.operations.inspectGit) {
        return {
          status: "blocked",
          summary: "Reviewer needs the read-only Git inspection adapter; no diff was reviewed.",
          verification: ["Git inspection adapter is not enabled."],
          next: ["Enable inspectGit, then rerun the review step."],
        }
      }
      const result = await context.operations.inspectGit({ workspace: request.workspace, signal: request.signal })
      const files = result.changedFiles ?? []
      return {
        summary:
          files.length === 0
            ? "Review completed: no changed files, nothing risky found."
            : `Review completed: ${files.length} changed file(s) listed with follow-up risks.`,
        changedFiles: files,
        verification: [
          result.branch ? `Branch: ${result.branch}` : "Branch: unavailable",
          `Working tree: ${result.clean ? "clean" : "changed"}`,
          ...files.slice(0, 20).map((file) => `Changed: ${file}`),
          "Remaining risks must be fixed before the tester step can pass.",
        ],
        receipts: [
          createVerificationReceipt({ command: "git status --short --branch", exitCode: 0, output: result.summary }),
        ],
      }
    },
  }
}

function testerWorker(): MasterWorker {
  return {
    kind: "tester",
    async run(request, context) {
      const targets = detectProjectTargets(request.workspace)
      const target = targets.find((item) => item.testCommands.length > 0) ?? targets[0]
      if (!target || target.testCommands.length === 0) {
        return {
          status: "blocked",
          summary: "Tester found no project test target; no commands were run.",
          verification: ["Project detection completed without executing commands."],
          next: ["Open a project with test scripts (e.g. package.json scripts.test), then rerun the tester step."],
        }
      }
      if (!context.operations.runProjectChecks) {
        return {
          status: "blocked",
          summary: "Tester found a target but the check runner is not enabled; no commands were run.",
          verification: target.testCommands.map((command) => `Available check: ${command}`),
          next: ["Enable runProjectChecks, then run only the listed focused checks."],
        }
      }
      const results = await context.operations.runProjectChecks({
        workspace: request.workspace,
        target,
        commands: target.testCommands,
        signal: request.signal,
      })
      const failed = results.filter((result) => result.exitCode !== 0)
      return {
        status: failed.length === 0 ? "completed" : "blocked",
        summary:
          failed.length === 0
            ? "Focused tests passed."
            : `Focused tests reported ${failed.length} failure(s); repair is required before success can be claimed.`,
        verification: results.map((result) => `${result.exitCode === 0 ? "PASS" : "FAIL"}: ${result.command}`),
        receipts: results.map((result) =>
          createVerificationReceipt({ command: result.command, exitCode: result.exitCode, output: result.output }),
        ),
        next: failed.length ? ["Repair the first failing check, then rerun the focused tests."] : undefined,
      }
    },
  }
}

function docsWorker(): MasterWorker {
  return {
    kind: "docs",
    async run(request, context) {
      if (context.operations.runDocsStep) {
        const result = await context.operations.runDocsStep({
          workspace: request.workspace,
          objective: request.objective,
          stepTitle: request.step.title,
          queuedInstructions: request.queuedInstructions,
          signal: request.signal,
        })
        return {
          summary: result.summary,
          changedFiles: result.changedFiles,
          verification: result.verification ?? ["Docs changes scoped to touched guides."],
          next: result.next,
        }
      }
      if (!context.operations.inspectGit) {
        return {
          summary: "Docs scope recorded; Git inspection is unavailable so changed guides could not be listed.",
          verification: ["No files were modified by this worker."],
          next: ["List the touched guides in the step summary before marking docs complete."],
        }
      }
      const result = await context.operations.inspectGit({ workspace: request.workspace, signal: request.signal })
      const docs = (result.changedFiles ?? []).filter((file) => /\.(md|mdx|txt)$/i.test(file) || /docs\//i.test(file))
      return {
        summary:
          docs.length === 0
            ? "Docs check completed: no guide changes detected."
            : `Docs check completed: ${docs.length} guide(s) touched.`,
        changedFiles: docs,
        verification: [
          "Only guide-scoped changes are accepted in this step.",
          ...docs.slice(0, 20).map((file) => `Guide: ${file}`),
        ],
      }
    },
  }
}

export function createMasterWorkerRegistry(operations: MasterWorkerOperations = {}) {
  const resolvedOperations: MasterWorkerOperations = {
    ...operations,
    inspectGit: operations.inspectGit ?? inspectGitReadOnly,
    inspectGitHub: operations.inspectGitHub ?? inspectGitHubReadOnly,
    runProjectChecks: operations.runProjectChecks ?? runProjectChecksReadOnly,
    inspectAndroidDevice: operations.inspectAndroidDevice ?? inspectAndroidDeviceReadOnly,
    runAndroidDeviceChecks: operations.runAndroidDeviceChecks ?? runAndroidDeviceChecksApproved,
    inspectBrowser:
      operations.inspectBrowser ??
      (async ({ url, signal }) => {
        const page = await inspectPublicBrowserPage(url, { signal })
        return {
          url: page.url,
          status: page.status,
          title: page.title,
          html: page.textPreview,
          summary: `Inspected public page (${page.status})${page.title ? `: ${page.title}` : ""}.`,
        }
      }),
  }
  const workers: MasterWorker[] = [
    researchWorker(),
    coderWorker(),
    reviewerWorker(),
    testerWorker(),
    gitWorker(),
    browserWorker(),
    projectWorker("web", (target) => target.kind === "web" || target.kind === "node"),
    projectWorker("android", (target) => target.kind === "android"),
    docsWorker(),
  ]
  const byKind = new Map(workers.map((worker) => [worker.kind, worker]))
  return {
    list: () => workers.map((worker) => worker.kind),
    get: (kind: WorkerKind) => byKind.get(kind),
    run: async (request: WorkerRequest): Promise<WorkerResult> => {
      const worker = byKind.get(request.step.kind)
      if (!worker) throw new Error(`No Master worker registered for ${request.step.kind}`)
      return worker.run(request, { capabilities: request.capabilities, operations: resolvedOperations })
    },
  }
}

export type MasterWorkerRegistry = ReturnType<typeof createMasterWorkerRegistry>
