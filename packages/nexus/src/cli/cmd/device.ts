import os from "node:os"
import fs from "node:fs/promises"
import { homedir } from "node:os"
import { EOL } from "node:os"
import { inspectDeviceGuard, type DeviceGuardSnapshot } from "@nexus/termux-core"
import { cmd } from "./cmd"

export type StorageReadiness = {
  totalBytes?: number
  availableBytes?: number
}

export type DeviceReadiness = {
  platform: "termux" | "desktop"
  architecture: string
  cpuCores: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  storage: StorageReadiness
  deviceGuard: DeviceGuardSnapshot
  observedOnly: true
}

export type DeviceReadinessProbe = {
  platform: "termux" | "desktop"
  architecture: string
  cpuCores: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  storage: StorageReadiness
  deviceGuard: DeviceGuardSnapshot
}

const GIB = 1024 * 1024 * 1024

function isTermux() {
  return Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"))
}

async function inspectStorage(): Promise<StorageReadiness> {
  try {
    const info = await fs.statfs(homedir())
    const blockSize = Number(info.bsize)
    const totalBytes = Number(info.blocks) * blockSize
    const availableBytes = Number(info.bavail) * blockSize
    if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes) || totalBytes < 0 || availableBytes < 0) {
      return {}
    }
    return { totalBytes, availableBytes }
  } catch {
    return {}
  }
}

export async function collectDeviceReadiness(): Promise<DeviceReadiness> {
  return createDeviceReadiness({
    platform: isTermux() ? "termux" : "desktop",
    architecture: process.arch,
    cpuCores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    storage: await inspectStorage(),
    deviceGuard: inspectDeviceGuard(),
  })
}

export function createDeviceReadiness(probe: DeviceReadinessProbe): DeviceReadiness {
  return { ...probe, observedOnly: true }
}

export function deviceReadinessAdvice(readiness: DeviceReadiness): string[] {
  const advice: string[] = []
  const freeMemoryGiB = readiness.freeMemoryBytes / GIB
  if (freeMemoryGiB < 1)
    advice.push("Low free memory observed; prefer small, serial tasks and avoid manual heavy local-model runs.")
  else if (freeMemoryGiB < 3)
    advice.push("Limited free memory observed; prefer bounded parallelism and lightweight local-model guidance.")
  else advice.push("Memory observation is suitable for normal bounded tasks; it is not a performance guarantee.")

  const storageGiB = readiness.storage.availableBytes === undefined ? undefined : readiness.storage.availableBytes / GIB
  if (storageGiB === undefined)
    advice.push(
      "Available storage could not be observed; confirm space manually before any optional download or extraction.",
    )
  else if (storageGiB < 4)
    advice.push(
      "Low available storage observed; do not begin optional local-model or archive-heavy work without freeing space first.",
    )
  else
    advice.push(
      "Available storage observation is informational; optional downloads still require explicit confirmation.",
    )

  if (readiness.platform === "termux") {
    for (const warning of readiness.deviceGuard.warnings) advice.push(`Termux guard: ${warning}`)
    if (readiness.deviceGuard.warnings.length === 0) {
      advice.push(
        "Termux guard has no current warning; battery, thermal, and network state can change and are not continuously monitored.",
      )
    }
  } else {
    advice.push(
      "Desktop readiness does not probe battery, thermal, GPU/VRAM, or network pricing; those conditions are not inferred.",
    )
  }
  return advice
}

function formatGiB(value: number | undefined): string {
  return value === undefined ? "not observed" : `${(value / GIB).toFixed(1)} GiB`
}

export function formatDeviceReadiness(readiness: DeviceReadiness, format: "table" | "json"): string {
  const advice = deviceReadinessAdvice(readiness)
  if (format === "json") return JSON.stringify({ ...readiness, advice }, null, 2)
  const lines = [
    `Device: ${readiness.platform === "termux" ? "Termux" : "PC"} · ${readiness.architecture} · ${readiness.cpuCores} CPU cores`,
    `Memory: ${formatGiB(readiness.freeMemoryBytes)} free / ${formatGiB(readiness.totalMemoryBytes)} total`,
    `Storage: ${formatGiB(readiness.storage.availableBytes)} available / ${formatGiB(readiness.storage.totalBytes)} total`,
    `Device guard: ${readiness.deviceGuard.level} · network ${readiness.deviceGuard.network}`,
    "Observed local signals only: no setup, download, service start, configuration write, model run, or data upload occurred.",
    "Guidance:",
    ...advice.map((item) => `- ${item}`),
  ]
  return lines.join(EOL)
}

export const DeviceReadinessCommand = cmd({
  command: "readiness",
  describe: "inspect local PC/Termux resource and safeguard signals without changing the device",
  builder: (yargs) =>
    yargs.option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  async handler(args) {
    const readiness = await collectDeviceReadiness()
    process.stdout.write(formatDeviceReadiness(readiness, args.format === "json" ? "json" : "table") + EOL)
  },
})

export const DeviceCommand = cmd({
  command: "device",
  describe: "local device readiness and safeguards",
  builder: (yargs) => yargs.command(DeviceReadinessCommand).demandCommand(),
  async handler() {},
})
