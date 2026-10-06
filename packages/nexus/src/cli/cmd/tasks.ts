import type { Argv } from "yargs"
import { Effect } from "effect"
import { Global } from "@nexus-ai/core/global"
import { addJob, describeJob, dueJobs, loadStore, markRun, parseCron, removeJob, saveStore } from "../../scheduler"
import { cmd } from "./cmd"
import { CliError, effectCmd } from "../effect-cmd"

function stateDir() {
  return Global.Path.state
}

function newId() {
  return `job_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`
}

const TasksAddCommand = cmd({
  command: "add <instructions>",
  describe: "schedule a one-shot reminder or recurring job",
  builder: (yargs: Argv) =>
    yargs
      .positional("instructions", { type: "string", demandOption: true, describe: "what the agent should do" })
      .option("at", { type: "string", describe: "ISO time for a one-shot job" })
      .option("in", { type: "string", describe: "delay like 20m, 2h, 1d" })
      .option("cron", { type: "string", describe: "5-field cron expression for recurring jobs" }),
  handler: async (args: { instructions: string; at?: string; in?: string; cron?: string }) => {
    const store = loadStore(stateDir())
    if (args.cron) {
      if (!parseCron(args.cron)) {
        console.log(`Invalid cron expression: ${args.cron}`)
        process.exitCode = 1
        return
      }
      const next = { id: newId(), kind: "cron" as const, expr: args.cron, instructions: args.instructions }
      saveStore(addJob(store, next), stateDir())
      console.log(`Scheduled recurring job ${next.id} (${args.cron}).`)
      return
    }
    let at: number | undefined
    if (args.at) {
      at = Date.parse(args.at)
      if (Number.isNaN(at)) {
        console.log(`Invalid time: ${args.at}`)
        process.exitCode = 1
        return
      }
    } else if (args.in) {
      const match = args.in.match(/^(\d+)(m|h|d)$/)
      if (!match) {
        console.log(`Invalid delay (use like 20m, 2h, 1d): ${args.in}`)
        process.exitCode = 1
        return
      }
      const multipliers: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 }
      at = Date.now() + Number(match[1]) * multipliers[match[2]]
    } else {
      console.log("Pass one of --at, --in, or --cron.")
      process.exitCode = 1
      return
    }
    const job = { id: newId(), kind: "once" as const, at, instructions: args.instructions }
    saveStore(addJob(store, job), stateDir())
    console.log(`Scheduled one-shot job ${job.id} at ${new Date(at).toISOString()}.`)
  },
})

const TasksListCommand = cmd({
  command: "list",
  describe: "list scheduled jobs and run history",
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false }),
  handler: async (args: { json?: boolean }) => {
    const store = loadStore(stateDir())
    if (args.json) {
      console.log(JSON.stringify(store, null, 2))
      return
    }
    if (store.jobs.length === 0) {
      console.log("No scheduled jobs.")
      return
    }
    for (const job of store.jobs) console.log(describeJob(job))
  },
})

const TasksRemoveCommand = cmd({
  command: "remove <id>",
  describe: "remove a scheduled job",
  builder: (yargs: Argv) => yargs.positional("id", { type: "string", demandOption: true }),
  handler: async (args: { id: string }) => {
    const { store, removed } = removeJob(loadStore(stateDir()), args.id)
    if (!removed) {
      console.log(`No job ${args.id}.`)
      process.exitCode = 1
      return
    }
    saveStore(store, stateDir())
    console.log(`Removed job ${args.id}.`)
  },
})

const TasksDueCommand = cmd({
  command: "due",
  describe: "show jobs due right now (execution hooks land with agent turns)",
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false }),
  handler: async (args: { json?: boolean }) => {
    const store = loadStore(stateDir())
    const due = dueJobs(store)
    if (args.json) {
      console.log(
        JSON.stringify(
          due.map((item) => ({ id: item.job.id, reason: item.reason })),
          null,
          2,
        ),
      )
      return
    }
    if (due.length === 0) {
      console.log("Nothing due.")
      return
    }
    for (const item of due) console.log(`${item.job.id}: ${item.reason} :: ${item.job.instructions.slice(0, 100)}`)
  },
})

const TasksAuditCommand = cmd({
  command: "audit",
  describe: "show run history across jobs",
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false }),
  handler: async (args: { json?: boolean }) => {
    const store = loadStore(stateDir())
    const rows = store.jobs.map((job) => ({ id: job.id, kind: job.kind, runs: job.runs, lastRun: job.lastRun ?? null }))
    if (args.json) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }
    if (rows.length === 0) {
      console.log("No jobs to audit.")
      return
    }
    for (const row of rows) {
      console.log(
        `${row.id} [${row.kind}] runs=${row.runs}${row.lastRun ? ` last=${new Date(row.lastRun).toISOString()}` : " never"}`,
      )
    }
  },
})

export const TasksCommand = cmd({
  command: "tasks",
  describe: "schedule reminders and recurring jobs, audit run history",
  builder: (yargs: Argv) =>
    yargs
      .command(TasksAddCommand)
      .command(TasksListCommand)
      .command(TasksRemoveCommand)
      .command(TasksDueCommand)
      .command(TasksAuditCommand)
      .command(TasksRunDueCommand)
      .demandCommand(),
  handler: () => undefined,
})

const TasksRunDueCommand = effectCmd({
  command: "run-due <session>",
  describe: "admit due jobs into a session as wakeup messages",
  builder: (yargs) =>
    yargs
      .positional("session", { describe: "session ID to wake", type: "string", demandOption: true })
      .option("agent", { describe: "agent to attribute wakeups to", type: "string" })
      .option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.tasks.runDue")(function* (args) {
    const { inject } = yield* Effect.promise(() => import("@/inbox"))
    let store = loadStore(stateDir())
    const due = dueJobs(store)
    const admitted: string[] = []
    for (const item of due) {
      yield* inject({
        sessionID: args.session,
        text: `[scheduled ${item.job.id}] ${item.job.instructions}`,
        agent: args.agent,
      }).pipe(Effect.mapError((error) => new CliError({ message: String(error) })))
      store = markRun(store, item.job.id)
      admitted.push(item.job.id)
    }
    saveStore(store, stateDir())
    if (args.json) {
      console.log(JSON.stringify({ admitted }, null, 2))
      return
    }
    console.log(
      admitted.length === 0
        ? "Nothing due."
        : `Admitted ${admitted.length} job(s) into ${args.session}: ${admitted.join(", ")}.`,
    )
  }),
})
