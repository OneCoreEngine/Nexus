import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { TelegramFactory, type BotTemplate } from "../../telegram/TelegramFactory"

const templates = TelegramFactory.listTemplates()

const CreateCommand = cmd({
  command: "create <name>",
  describe: "create a Telegram bot from a built-in template",
  builder: (yargs: Argv) =>
    yargs.option("template", {
      type: "string",
      alias: "t",
      choices: [...templates],
      default: "echo",
      describe: "template to use",
    }),
  async handler(args) {
    if (typeof args.name !== "string" || typeof args.template !== "string")
      throw new Error("Bot name and template are required")
    const path = TelegramFactory.createBot(args.name, args.template as BotTemplate)
    process.stdout.write(`Created ${args.name} (${args.template}) at ${path}\n`)
  },
})

const DeployCommand = cmd({
  command: "deploy <name>",
  describe: "run a bot as a Termux background service",
  builder: (yargs: Argv) => yargs,
  async handler(args) {
    if (typeof args.name !== "string") throw new Error("Bot name is required")
    const path = TelegramFactory.deployBot(args.name)
    process.stdout.write(`Deployed ${args.name}; service files: ${path}\n`)
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show local bot service status",
  builder: (yargs: Argv) => yargs,
  async handler() {
    const status = TelegramFactory.status()
    if (status.length === 0) {
      process.stdout.write("No bots found.\n")
      return
    }
    for (const bot of status)
      process.stdout.write(`${bot.running ? "running" : "stopped"}\t${bot.name}${bot.pid ? `\tpid=${bot.pid}` : ""}\n`)
  },
})

const TemplateListCommand = cmd({
  command: "template-list",
  describe: "list built-in Telegram bot templates",
  builder: (yargs: Argv) => yargs,
  async handler() {
    for (const template of templates) process.stdout.write(`${template}\n`)
  },
})

export const BotCommand = cmd({
  command: "bot",
  describe: "create and manage Termux Telegram bots",
  builder: (yargs: Argv) =>
    yargs
      .command(CreateCommand)
      .command(DeployCommand)
      .command(StatusCommand)
      .command(TemplateListCommand)
      .demandCommand(),
  async handler() {},
})
