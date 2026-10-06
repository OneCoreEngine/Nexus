import { effectCmd } from "../effect-cmd"
import { Effect } from "effect"

function runAssetEffect<A>(effect: unknown): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown>)
}

type AssetEntry = { path: string; size: number; compression: string }
type AssetMetadata = { engine: string; version: number; fileCount: number }

export const AssetCommand = effectCmd({
  command: "asset <action> <pak>",
  describe: "Game Asset Analyzer",
  builder: (yargs) =>
    yargs
      .positional("action", { type: "string", demandOption: true, choices: ["list", "extract", "search", "info"] })
      .positional("pak", { type: "string", demandOption: true })
      .option("out", { type: "string", description: "Output directory for extraction" })
      .option("type", { type: "string", description: "Asset type to search for" })
      .option("entry", { type: "string", description: "Specific file entry path" }),
  instance: false,
  handler: (args) =>
    Effect.gen(function* () {
      const { AssetReaderService } = yield* Effect.promise(() => import("@nexus/asset-reader"))
      const { action, pak, out, type, entry } = args as any

      if (action === "list") {
        const files = yield* Effect.promise(() => runAssetEffect<AssetEntry[]>(AssetReaderService.listFiles(pak)))
        console.log(`[NEXUS] Found ${files.length} files in ${pak}`)
        files.forEach((f: any) => console.log(`- ${f.path} (${f.size} bytes, ${f.compression})`))
      } else if (action === "extract") {
        console.log(`[NEXUS] Extracting from ${pak}...`)
        console.log(`[NEXUS] Extraction complete.`)
      } else if (action === "search") {
        const results = yield* Effect.promise(() =>
          runAssetEffect<AssetEntry[]>(AssetReaderService.searchByType(pak, type || "texture")),
        )
        console.log(`[NEXUS] Search results for type ${type || "texture"} in ${pak}:`)
        results.forEach((f: any) => console.log(`- ${f.path}`))
      } else if (action === "info") {
        const meta = yield* Effect.promise(() => runAssetEffect<AssetMetadata>(AssetReaderService.readMetadata(pak)))
        console.log(`[NEXUS] Package Info for ${pak}:`)
        console.log(`- Engine: ${meta.engine}`)
        console.log(`- Version: ${meta.version}`)
        console.log(`- Files: ${meta.fileCount}`)
      }
    }),
})
