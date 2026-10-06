import { Effect } from "effect"
import type { Argv } from "yargs"
import { Global } from "@nexus-ai/core/global"
import { dueJobs, loadStore } from "../../scheduler"
import { check, batteryOf } from "../../heartbeat"
import { readIncidentFiles } from "../../lessons"
import { cmd } from "./cmd"

async function termuxApi() {
  return Effect.runPromise(Effect.promise(() => import("@nexus/termux-api")).pipe(Effect.map((mod) => mod.TermuxAPI)))
}

function runTermuxEffect<A>(effect: unknown): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown>)
}

async function batteryPercent(): Promise<number> {
  try {
    const api = await termuxApi()
    return batteryOf(await runTermuxEffect(api.getBatteryStatus()))
  } catch {
    return 100
  }
}

async function notify(title: string, body: string): Promise<boolean> {
  try {
    const api = await termuxApi()
    await runTermuxEffect(api.notify(title, body))
    return true
  } catch {
    return false
  }
}

export const HeartbeatCommand = cmd({
  command: "heartbeat",
  describe: "run one ambient monitor check (quiet by default, speaks only when it matters)",
  builder: (yargs: Argv) =>
    yargs
      .option("json", { type: "boolean", default: false, describe: "print machine-readable output" })
      .option("base-minutes", { type: "number", default: 30, describe: "base interval between checks" }),
  handler: async (args: { json?: boolean; baseMinutes?: number }) => {
    const now = Date.now()
    const store = loadStore(Global.Path.state)
    const due = dueJobs(store, now)
    const critical = readIncidentFiles(Global.Path.state).filter((item) => item.severity === "critical").length
    const decision = check({
      nowMs: now,
      batteryPercent: await batteryPercent(),
      baseMinutes: args.baseMinutes ?? 30,
      dueCount: due.length,
      criticalCount: critical,
      quiet: { startHour: 22, endHour: 7 },
      alertsAt: [],
      maxAlerts: 3,
      alertWindowMs: 60 * 60 * 1000,
    })
    const message =
      due.length > 0
        ? `${due.length} job(s) due: ${due
            .map((item) => item.job.instructions)
            .join("; ")
            .slice(0, 200)}`
        : critical > 0
          ? `${critical} critical incident(s) need attention`
          : decision.reason
    if (decision.speak) {
      const announced = await notify("NEXUS", message)
      if (args.json) {
        console.log(JSON.stringify({ ...decision, announced, due: due.map((item) => item.job.id), message }, null, 2))
        return
      }
      console.log(announced ? `Announced: ${decision.reason}.` : message)
      return
    }
    if (args.json) {
      console.log(
        JSON.stringify({ ...decision, announced: false, due: due.map((item) => item.job.id), message }, null, 2),
      )
      return
    }
    console.log(decision.run ? `Silent turn: ${decision.reason}.` : decision.reason)
  },
})
