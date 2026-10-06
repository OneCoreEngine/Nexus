import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { EOL } from "node:os"
import { cmd } from "./cmd"

export const inspectableArtifactKinds = ["apk", "obb", "pak"] as const
export type InspectableArtifactKind = (typeof inspectableArtifactKinds)[number]

export type ArtifactInventoryEntry = {
  name: string
  compressedBytes: number
  uncompressedBytes: number
}

export type ArtifactInspection = {
  kind: InspectableArtifactKind
  path: string
  sizeBytes: number
  modifiedAt: string
  fingerprint: string
  archive: boolean
  inventory: ArtifactInventoryEntry[]
  inventoryTruncated: boolean
  boundaries: readonly string[]
}

const MAX_INVENTORY_ENTRIES = 64
const ZIP_TAIL_BYTES = 66_000
const ZIP_CENTRAL_HEADER = 0x02014b50
const ZIP_END_HEADER = 0x06054b50

function artifactKind(filePath: string): InspectableArtifactKind | undefined {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  return inspectableArtifactKinds.find((kind) => kind === extension)
}

function safeInventoryName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").replace(/\\/g, "/")
  return normalized
    .replace(/(?:api[_-]?key|access[_-]?token|bearer|password|secret)[^/]{0,96}/gi, "[redacted-name]")
    .slice(0, 180)
}

function findZipEnd(buffer: Buffer): number | undefined {
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === ZIP_END_HEADER) return index
  }
  return undefined
}

async function readZipInventory(
  filePath: string,
  sizeBytes: number,
): Promise<{ entries: ArtifactInventoryEntry[]; truncated: boolean }> {
  const handle = await fs.open(filePath, "r")
  try {
    const tailLength = Math.min(sizeBytes, ZIP_TAIL_BYTES)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, sizeBytes - tailLength)
    const end = findZipEnd(tail)
    if (end === undefined || end + 22 > tail.length) return { entries: [], truncated: false }

    const entryCount = tail.readUInt16LE(end + 10)
    const centralDirectorySize = tail.readUInt32LE(end + 12)
    const centralDirectoryOffset = tail.readUInt32LE(end + 16)
    if (centralDirectoryOffset + centralDirectorySize > sizeBytes || centralDirectorySize > 8 * 1024 * 1024) {
      return { entries: [], truncated: false }
    }

    const directory = Buffer.alloc(centralDirectorySize)
    await handle.read(directory, 0, centralDirectorySize, centralDirectoryOffset)
    const entries: ArtifactInventoryEntry[] = []
    let cursor = 0
    let parsed = 0
    while (cursor + 46 <= directory.length && parsed < entryCount && entries.length < MAX_INVENTORY_ENTRIES) {
      if (directory.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER) break
      const compressedBytes = directory.readUInt32LE(cursor + 20)
      const uncompressedBytes = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28)
      const extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      const endOfEntry = cursor + 46 + nameLength + extraLength + commentLength
      if (endOfEntry > directory.length) break
      const rawName = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8")
      entries.push({ name: safeInventoryName(rawName), compressedBytes, uncompressedBytes })
      cursor = endOfEntry
      parsed += 1
    }
    return { entries, truncated: entryCount > entries.length }
  } finally {
    await handle.close()
  }
}

async function sparseFingerprint(filePath: string, sizeBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r")
  try {
    const sampleLength = Math.min(sizeBytes, 32 * 1024)
    const first = Buffer.alloc(sampleLength)
    await handle.read(first, 0, sampleLength, 0)
    const last = Buffer.alloc(sampleLength)
    if (sizeBytes > sampleLength) await handle.read(last, 0, sampleLength, Math.max(0, sizeBytes - sampleLength))
    return crypto
      .createHash("sha256")
      .update(String(sizeBytes))
      .update(first)
      .update(sizeBytes > sampleLength ? last : Buffer.alloc(0))
      .digest("hex")
      .slice(0, 16)
  } finally {
    await handle.close()
  }
}

/**
 * Reads bounded metadata and a ZIP central-directory inventory only. The caller
 * must already have authorization; this function never executes, extracts,
 * decrypts, repacks, modifies, or uploads the artifact.
 */
export async function inspectAuthorizedArtifact(filePath: string): Promise<ArtifactInspection> {
  const absolutePath = path.resolve(filePath)
  const kind = artifactKind(absolutePath)
  if (!kind) throw new Error(`Supported artifact extensions: ${inspectableArtifactKinds.join(", ")}`)
  const stat = await fs.lstat(absolutePath)
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not accepted for artifact inspection.")
  if (!stat.isFile()) throw new Error("Artifact inspection requires a regular file.")

  const archive = kind === "apk" || kind === "obb"
  const inventory = archive ? await readZipInventory(absolutePath, stat.size) : { entries: [], truncated: false }
  return {
    kind,
    path: absolutePath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    fingerprint: await sparseFingerprint(absolutePath, stat.size),
    archive,
    inventory: inventory.entries,
    inventoryTruncated: inventory.truncated,
    boundaries: [
      "Read-only metadata and central-directory inventory only.",
      "No extraction, execution, decryption, patching, upload, installation, account access, DRM bypass, or data-extraction bypass.",
      "Archive entry names are bounded and redact common credential-like filename fragments.",
    ],
  }
}

export function formatArtifactInspection(inspection: ArtifactInspection, format: "table" | "json"): string {
  if (format === "json") return JSON.stringify(inspection, null, 2)
  const lines = [
    `Artifact: ${inspection.path}`,
    `Kind: ${inspection.kind.toUpperCase()}`,
    `Size: ${inspection.sizeBytes} bytes`,
    `Modified: ${inspection.modifiedAt}`,
    `Local sparse fingerprint: ${inspection.fingerprint}`,
    `Archive inventory: ${inspection.archive ? "central-directory only" : "not applicable for PAK metadata mode"}`,
  ]
  if (inspection.inventory.length > 0) {
    lines.push("Bounded archive entries:")
    for (const entry of inspection.inventory) {
      lines.push(
        `- ${entry.name} (${entry.compressedBytes} compressed / ${entry.uncompressedBytes} uncompressed bytes)`,
      )
    }
    if (inspection.inventoryTruncated) lines.push(`- … inventory truncated after ${MAX_INVENTORY_ENTRIES} entries`)
  }
  lines.push("Safety boundaries:")
  for (const boundary of inspection.boundaries) lines.push(`- ${boundary}`)
  return lines.join(EOL)
}

export const ArtifactInspectCommand = cmd({
  command: "inspect <path>",
  describe: "inspect an authorized APK, OBB, or PAK with bounded read-only metadata; never extract or execute",
  builder: (yargs) =>
    yargs
      .positional("path", { type: "string", demandOption: true, describe: "authorized local artifact path" })
      .option("authorized", {
        type: "boolean",
        default: false,
        describe: "confirm you are authorized to inspect this artifact",
      })
      .option("format", { choices: ["table", "json"] as const, default: "table", describe: "output format" }),
  async handler(args) {
    if (!args.authorized) {
      throw new Error(
        "Refusing artifact inspection without --authorized. Inspect only artifacts you own or are authorized to analyze.",
      )
    }
    const inspection = await inspectAuthorizedArtifact(args.path)
    process.stdout.write(formatArtifactInspection(inspection, args.format === "json" ? "json" : "table") + EOL)
  },
})

export const ArtifactCommand = cmd({
  command: "artifact",
  describe: "authorized read-only Android artifact inspection",
  builder: (yargs) => yargs.command(ArtifactInspectCommand).demandCommand(),
  async handler() {},
})
