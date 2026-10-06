import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { fail } from "../effect-cmd"
import { UI } from "../ui"

function runModEffect<A>(effect: unknown): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown>)
}

export const ModCommand = effectCmd({
  command: "mod <action>",
  describe: "Tier 3: Advanced Modding and Reverse Engineering",
  builder: (y) =>
    y
      .positional("action", {
        describe: "Action to perform (decompile, find, dump, gen)",
        type: "string",
      })
      .option("apk", { type: "string", describe: "Path to APK file" })
      .option("out", { type: "string", describe: "Output directory" })
      .option("pattern", { type: "string", describe: "Search pattern" })
      .option("type", { type: "string", describe: "Search type (method, class, string)" })
      .option("lib", { type: "string", describe: "Path to libil2cpp.so" })
      .option("meta", { type: "string", describe: "Path to global-metadata.dat" })
      .option("pkg", { type: "string", describe: "Game package name" })
      .option("arch", { type: "string", describe: "Architecture (arm64, armv7)" })
      .option("method", { type: "string", describe: "Modding method (hook, patch)" }),
  handler: (args) =>
    Effect.gen(function* () {
      UI.println(UI.Style.TEXT_NORMAL, "Loading Tier 3 Modding module...")

      // Lazy load to save RAM on startup
      const { ModdingService } = yield* Effect.promise(() => import("@nexus/modding"))

      switch (args.action) {
        case "decompile":
          if (!args.apk) return yield* fail("--apk is required")
          const res1 = yield* Effect.promise(() =>
            runModEffect<string>(ModdingService.mod_apk_decompile({ apkPath: args.apk!, outputDir: args.out })),
          )
          UI.println(UI.Style.TEXT_SUCCESS, "✓", UI.Style.TEXT_NORMAL, res1)
          break
        case "find":
          if (!args.out || !args.pattern) return yield* fail("--out and --pattern are required")
          const res2 = yield* Effect.promise(() =>
            runModEffect<string>(
              ModdingService.mod_smali_find({
                decompiledDir: args.out!,
                pattern: args.pattern!,
                type: args.type || "string",
              }),
            ),
          )
          UI.println(UI.Style.TEXT_SUCCESS, "✓", UI.Style.TEXT_NORMAL, res2)
          break
        case "dump":
          if (!args.lib || !args.meta) return yield* fail("--lib and --meta are required")
          const res3 = yield* Effect.promise(() =>
            runModEffect<string>(ModdingService.mod_il2cpp_dump({ libPath: args.lib!, metadataPath: args.meta! })),
          )
          UI.println(UI.Style.TEXT_SUCCESS, "✓", UI.Style.TEXT_NORMAL, res3)
          break
        case "gen":
          if (!args.pkg) return yield* fail("--pkg is required")
          const res4 = yield* Effect.promise(() =>
            runModEffect<string>(
              ModdingService.mod_menu_gen({
                gamePackage: args.pkg!,
                version: "1.0",
                arch: args.arch || "arm64",
                features: ["aimbot", "esp"],
                method: args.method || "hook",
              }),
            ),
          )
          UI.println(UI.Style.TEXT_SUCCESS, "✓", UI.Style.TEXT_NORMAL, res4)
          break
        default:
          return yield* fail(`Unknown action: ${args.action}`)
      }
    }),
})
