import type { Argv } from "yargs"
import { cmd } from "./cmd"

export const DoCommand = cmd({
  command: "do <task>",
  describe: "analyze a task and hire only the required Termux freelancers",
  builder: (yargs: Argv) =>
    yargs.positional("task", {
      type: "string",
      describe: "task for the Businessman orchestrator",
    }),
  async handler(args) {
    try {
      const { Businessman } = await import("@nexus/termux-core")
      const businessman = new Businessman()
      if (typeof args.task !== "string") throw new Error("Task is required")
      await businessman.handleTask(args.task)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("Cannot find module") || message.includes("Module not found")) {
        process.stderr.write("Termux core is unavailable. Reinstall NEXUS or run: bun install\n")
        return
      }
      throw error
    }
  },
})
