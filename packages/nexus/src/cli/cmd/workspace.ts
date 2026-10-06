import fs from "node:fs/promises"
import { basename, join } from "node:path"
import { EOL } from "os"
import { Effect } from "effect"
import { Global } from "@nexus-ai/core/global"
import { ProjectV2 } from "@nexus-ai/core/project"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"
import { Project } from "@/project/project"

export type WorkspaceSummary = {
  id: string
  name: string
  vcs: string
  updated: number
  sandboxCount: number
}

export type WorkspaceDetail = WorkspaceSummary & {
  worktree: string
}

export type WorkspaceSelection = {
  version: 1
  projectID: string
  selectedAt: number
}

export function validatedWorkspaceDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized && normalized.length <= 80 ? normalized : undefined
}

function safeWorkspaceName(value: string | undefined): string {
  const normalized = (value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return normalized ? normalized.slice(0, 80) : "(unnamed project)"
}

export function workspaceSummary(project: Project.Info): WorkspaceSummary {
  return {
    id: project.id,
    name: safeWorkspaceName(project.name),
    vcs: project.vcs ?? "none",
    updated: project.time.updated,
    sandboxCount: project.sandboxes.length,
  }
}

export function workspaceDetail(project: Project.Info): WorkspaceDetail {
  return {
    ...workspaceSummary(project),
    worktree: project.worktree
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  }
}

export function formatWorkspaceList(projects: Project.Info[], format: "table" | "json"): string {
  const entries = projects
    .map(workspaceSummary)
    .sort((left, right) => right.updated - left.updated || left.name.localeCompare(right.name))

  if (format === "json") return JSON.stringify(entries, null, 2)
  if (entries.length === 0) return "No known local projects. Open a project with NEXUS to add it to the local registry."

  const idWidth = Math.max(10, ...entries.map((entry) => entry.id.length))
  const nameWidth = Math.max(16, ...entries.map((entry) => entry.name.length))
  const header = `Project ID${" ".repeat(idWidth - 10)}  Name${" ".repeat(nameWidth - 4)}  VCS  Sandboxes  Updated`
  const lines = [header, "─".repeat(header.length)]
  for (const entry of entries) {
    lines.push(
      `${entry.id.padEnd(idWidth)}  ${entry.name.padEnd(nameWidth)}  ${entry.vcs.padEnd(4)}  ${String(entry.sandboxCount).padStart(9)}  ${new Date(entry.updated).toISOString()}`,
    )
  }
  return lines.join(EOL)
}

export function formatWorkspaceDetail(project: Project.Info, format: "table" | "json"): string {
  const detail = workspaceDetail(project)
  if (format === "json") return JSON.stringify(detail, null, 2)
  return [
    `Project ID: ${detail.id}`,
    `Name: ${detail.name}`,
    `VCS: ${detail.vcs}`,
    `Worktree: ${detail.worktree}`,
    `Sandboxes: ${detail.sandboxCount}`,
    `Updated: ${new Date(detail.updated).toISOString()}`,
    "Read-only detail: no project metadata, directory, source file, configuration, or selection state changed.",
  ].join(EOL)
}

function posixShellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Returns a copy-only navigation command. It never changes the caller's shell. */
export function workspaceNavigationCommand(directory: string, platform = process.platform): string {
  return platform === "win32"
    ? `Set-Location -LiteralPath ${powerShellLiteral(directory)}`
    : `cd -- ${posixShellLiteral(directory)}`
}

export function workspaceSelectionPath(configDirectory = Global.Path.config): string {
  return join(configDirectory, "workspace-selection.json")
}

export async function readWorkspaceSelection(
  configDirectory = Global.Path.config,
): Promise<WorkspaceSelection | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(workspaceSelectionPath(configDirectory), "utf8"),
    ) as Partial<WorkspaceSelection>
    if (
      parsed.version !== 1 ||
      typeof parsed.projectID !== "string" ||
      !parsed.projectID ||
      typeof parsed.selectedAt !== "number" ||
      !Number.isFinite(parsed.selectedAt)
    )
      return undefined
    return { version: 1, projectID: parsed.projectID, selectedAt: parsed.selectedAt }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return undefined
  }
}

export async function writeWorkspaceSelection(input: {
  configDirectory?: string
  projectID: string
  selectedAt?: number
}): Promise<WorkspaceSelection> {
  const configDirectory = input.configDirectory ?? Global.Path.config
  const selection: WorkspaceSelection = {
    version: 1,
    projectID: input.projectID,
    selectedAt: input.selectedAt ?? Date.now(),
  }
  await fs.mkdir(configDirectory, { recursive: true })
  const destination = workspaceSelectionPath(configDirectory)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(selection, null, 2) + "\n", { encoding: "utf8", flag: "wx" })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
  return selection
}

export async function clearWorkspaceSelection(configDirectory = Global.Path.config): Promise<boolean> {
  try {
    await fs.unlink(workspaceSelectionPath(configDirectory))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export function formatWorkspaceSelection(selection: WorkspaceSelection | undefined, project?: Project.Info): string {
  if (!selection) return "No local workspace selection bookmark. This does not affect the current shell directory."
  const name = project ? safeWorkspaceName(project.name) : "(known project no longer available)"
  return [
    `Selected workspace bookmark: ${selection.projectID}`,
    `Name: ${name}`,
    `Saved: ${new Date(selection.selectedAt).toISOString()}`,
    "Bookmark only: it does not change the current shell directory, project configuration, source files, or active session.",
  ].join(EOL)
}

export const WorkspaceListCommand = effectCmd({
  command: "list",
  aliases: ["ls", "$0"],
  describe: "list NEXUS-known local projects using safe metadata only",
  instance: false,
  builder: (yargs) =>
    yargs.option("format", {
      describe: "output format",
      type: "string",
      choices: ["table", "json"],
      default: "table",
    }),
  handler: Effect.fn("Cli.workspace.list")(function* (args) {
    const projects = yield* Project.Service.use((service) => service.list())
    const format = args.format === "json" ? "json" : "table"
    process.stdout.write(formatWorkspaceList(projects, format) + EOL)
  }),
})

export const WorkspaceCdCommand = effectCmd({
  command: "cd <projectID>",
  describe: "print a copy-only shell command to navigate to a known local project",
  instance: false,
  builder: (yargs) =>
    yargs.positional("projectID", {
      describe: "project ID from `nexus workspace list`",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.workspace.cd")(function* (args) {
    if (!args.projectID) return yield* fail("Project ID is required")
    const projectID = args.projectID
    const project = yield* Project.Service.use((service) => service.get(ProjectV2.ID.make(projectID)))
    if (!project) return yield* fail(`Known project not found: ${args.projectID}`)

    process.stdout.write(`# ${project.name?.trim() || basename(project.worktree) || "known project"}${EOL}`)
    process.stdout.write(workspaceNavigationCommand(project.worktree) + EOL)
  }),
})

export const WorkspaceShowCommand = effectCmd({
  command: "show <projectID>",
  describe: "show explicit safe detail for one known local project without changing it",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("projectID", {
        describe: "project ID from `nexus workspace list`",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.workspace.show")(function* (args) {
    if (!args.projectID) return yield* fail("Project ID is required")
    const projectID = args.projectID
    const project = yield* Project.Service.use((service) => service.get(ProjectV2.ID.make(projectID)))
    if (!project) return yield* fail(`Known project not found: ${args.projectID}`)
    const format = args.format === "json" ? "json" : "table"
    process.stdout.write(formatWorkspaceDetail(project, format) + EOL)
  }),
})

export const WorkspaceRenameCommand = effectCmd({
  command: "rename <projectID>",
  describe: "set a confirmed local display name for one known project; never changes project files",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("projectID", {
        describe: "project ID from `nexus workspace list`",
        type: "string",
        demandOption: true,
      })
      .option("name", {
        describe: "new local display name (1–80 printable characters)",
        type: "string",
        demandOption: true,
      })
      .option("confirm", {
        describe: "explicitly confirm changing only this local registry display name",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.workspace.rename")(function* (args) {
    if (!args.projectID) return yield* fail("Project ID is required")
    const projectID = args.projectID
    const name = validatedWorkspaceDisplayName(args.name)
    if (!name) return yield* fail("--name must contain 1–80 printable characters")
    if (!args.confirm) return yield* fail("Workspace display-name changes require --confirm")
    const updated = yield* Project.Service.use((service) =>
      service.update({ projectID: ProjectV2.ID.make(projectID), name }),
    ).pipe(Effect.mapError((error) => new CliError({ message: String(error) })))
    process.stdout.write(
      `Updated local display name for ${updated.id} to ${JSON.stringify(updated.name)}. No project files, commands, icon, worktree, sandbox, configuration, or selection state changed.${EOL}`,
    )
  }),
})

export const WorkspaceSelectedCommand = effectCmd({
  command: "selected",
  describe: "show the local workspace selection bookmark without changing anything",
  instance: false,
  handler: Effect.fn("Cli.workspace.selected")(function* () {
    const selection = yield* Effect.tryPromise({
      try: () => readWorkspaceSelection(),
      catch: (error) => new CliError({ message: `Unable to read workspace selection: ${String(error)}` }),
    })
    const project = selection
      ? yield* Project.Service.use((service) => service.get(ProjectV2.ID.make(selection.projectID)))
      : undefined
    process.stdout.write(formatWorkspaceSelection(selection, project) + EOL)
  }),
})

export const WorkspaceSelectCommand = effectCmd({
  command: "select <projectID>",
  describe: "save a confirmed local workspace bookmark; never changes the shell or project files",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("projectID", {
        describe: "project ID from `nexus workspace list`",
        type: "string",
        demandOption: true,
      })
      .option("confirm", {
        describe: "explicitly confirm saving this local workspace bookmark",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.workspace.select")(function* (args) {
    if (!args.projectID) return yield* fail("Project ID is required")
    const projectID = args.projectID
    if (!args.confirm) return yield* fail("Saving a workspace selection bookmark requires --confirm")
    const project = yield* Project.Service.use((service) => service.get(ProjectV2.ID.make(projectID)))
    if (!project) return yield* fail(`Known project not found: ${args.projectID}`)
    yield* Effect.tryPromise({
      try: () => writeWorkspaceSelection({ projectID: project.id }),
      catch: (error) => new CliError({ message: `Unable to save workspace selection: ${String(error)}` }),
    })
    process.stdout.write(
      `Saved local workspace bookmark for ${project.id}. It does not change the shell, source files, project config, or active session.${EOL}`,
    )
  }),
})

export const WorkspaceClearSelectionCommand = effectCmd({
  command: "clear-selection",
  describe: "remove the local workspace selection bookmark after explicit confirmation",
  instance: false,
  builder: (yargs) =>
    yargs.option("confirm", {
      describe: "explicitly confirm removing the local workspace bookmark",
      type: "boolean",
      default: false,
    }),
  handler: Effect.fn("Cli.workspace.clearSelection")(function* (args) {
    if (!args.confirm) return yield* fail("Removing a workspace selection bookmark requires --confirm")
    const removed = yield* Effect.tryPromise({
      try: () => clearWorkspaceSelection(),
      catch: (error) => new CliError({ message: `Unable to clear workspace selection: ${String(error)}` }),
    })
    process.stdout.write(
      `${removed ? "Removed" : "No"} local workspace selection bookmark. Shell, project config, source files, and active session were not changed.${EOL}`,
    )
  }),
})

export const WorkspaceCommand = cmd({
  command: "workspace",
  describe: "discover and navigate NEXUS-known local projects without changing them",
  builder: (yargs) =>
    yargs
      .command(WorkspaceListCommand)
      .command(WorkspaceCdCommand)
      .command(WorkspaceShowCommand)
      .command(WorkspaceRenameCommand)
      .command(WorkspaceSelectedCommand)
      .command(WorkspaceSelectCommand)
      .command(WorkspaceClearSelectionCommand)
      .demandCommand(),
  async handler() {},
})
