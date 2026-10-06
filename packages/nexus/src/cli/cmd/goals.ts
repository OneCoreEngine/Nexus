import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { NotFoundError } from "@/storage/storage"
import { closeGoal, makeGoal, readGoals, stageGoal, summarizeGoals } from "../../goals"
import { effectCmd, fail } from "../effect-cmd"
import { cmd } from "./cmd"

function sessionID(args: { session: string }) {
  return SessionID.make(args.session)
}

const GoalsListCommand = effectCmd({
  command: "list",
  describe: "show objectives for a session",
  builder: (yargs) =>
    yargs
      .option("session", { describe: "session ID", type: "string", demandOption: true })
      .option("format", { describe: "output format", type: "string", choices: ["table", "json"], default: "table" }),
  handler: Effect.fn("Cli.goals.list")(function* (args) {
    const svc = yield* Session.Service
    const info = yield* svc
      .get(sessionID(args))
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.session}`)))
    const goals = readGoals(info.metadata)
    if (args.format === "json") {
      console.log(JSON.stringify(goals, null, 2))
      return
    }
    console.log(summarizeGoals(goals))
  }),
})

const GoalsSetCommand = effectCmd({
  command: "set <session> <title>",
  describe: "add an objective to a session",
  builder: (yargs) =>
    yargs
      .positional("session", { describe: "session ID", type: "string", demandOption: true })
      .positional("title", { describe: "objective title", type: "string", demandOption: true })
      .option("notes", { describe: "extra notes", type: "string" }),
  handler: Effect.fn("Cli.goals.set")(function* (args) {
    const svc = yield* Session.Service
    const info = yield* svc
      .get(sessionID(args))
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.session}`)))
    const goal = { ...makeGoal(args.title), ...(args.notes ? { notes: args.notes } : {}) }
    yield* svc.setMetadata({
      sessionID: info.id,
      metadata: stageGoal(info.metadata as Record<string, unknown> | undefined, goal),
    })
    console.log(`Goal ${goal.id} added to ${args.session}.`)
  }),
})

function statusCommand(status: "done" | "dropped") {
  return effectCmd({
    command: `${status} <session> <id>`,
    describe: `mark a session objective ${status}`,
    builder: (yargs) =>
      yargs
        .positional("session", { describe: "session ID", type: "string", demandOption: true })
        .positional("id", { describe: "goal ID", type: "string", demandOption: true }),
    handler: Effect.fn(`Cli.goals.${status}`)(function* (args) {
      const svc = yield* Session.Service
      const info = yield* svc
        .get(sessionID(args))
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.session}`)))
      const goals = readGoals(info.metadata)
      const changed = closeGoal(goals, args.id, status).find((goal) => goal.id === args.id)
      if (!changed) return yield* fail(`Goal not found: ${args.id}`)
      yield* svc.setMetadata({
        sessionID: info.id,
        metadata: stageGoal(info.metadata as Record<string, unknown> | undefined, changed),
      })
      console.log(`Goal ${args.id} marked ${status}.`)
    }),
  })
}

export const GoalsCommand = cmd({
  command: "goals",
  describe: "track per-session objectives",
  builder: (yargs) =>
    yargs
      .command(GoalsListCommand)
      .command(GoalsSetCommand)
      .command(statusCommand("done"))
      .command(statusCommand("dropped"))
      .demandCommand(),
  async handler() {},
})
