import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 10_000

export class TermuxApiError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = "TermuxApiError"
  }
}

const nativeTermux = () => Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"))

const command = (name: string, args: string[] = []) =>
  Effect.tryPromise({
    try: async () => {
      if (!nativeTermux()) throw new TermuxApiError(`${name} is available only in native Termux.`)
      try {
        const { stdout } = await execFileAsync(name, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 })
        return stdout.trim()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT")
          throw new TermuxApiError(
            `Termux:API command '${name}' is unavailable. Install and open Termux:API, then run: pkg install termux-api`,
            error,
          )
        throw new TermuxApiError(`${name} failed. Check Termux:API permissions and try again.`, error)
      }
    },
    catch: (error) =>
      error instanceof TermuxApiError ? error : new TermuxApiError("Termux:API command failed.", error),
  })

const jsonCommand = (name: string, args: string[] = []) =>
  command(name, args).pipe(
    Effect.map((value) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        throw new TermuxApiError(`${name} returned invalid JSON.`)
      }
    }),
  )

export type ApkMetadata = {
  packageName?: string
  versionCode?: string
  versionName?: string
  minSdkVersion?: string
  targetSdkVersion?: string
  applicationLabel?: string
  launchableActivity?: string
  raw: string
}

const quotedField = (line: string | undefined, field: string) => line?.match(new RegExp(`${field}='([^']*)'`))?.[1]
const lineValue = (line: string | undefined) => line?.match(/:\s*'([^']*)'/)?.[1]

export const parseAaptBadging = (output: string): ApkMetadata => {
  const lines = output.split(/\r?\n/)
  const lineWith = (prefix: string) => lines.find((line) => line.startsWith(prefix))
  const packageLine = lineWith("package:")
  return {
    packageName: quotedField(packageLine, "name"),
    versionCode: quotedField(packageLine, "versionCode"),
    versionName: quotedField(packageLine, "versionName"),
    minSdkVersion: lineValue(lineWith("sdkVersion:")),
    targetSdkVersion: lineValue(lineWith("targetSdkVersion:")),
    applicationLabel: lineValue(lineWith("application-label:")),
    launchableActivity: quotedField(lineWith("launchable-activity:"), "name"),
    raw: output.trim(),
  }
}

const analyzeApk = (apkPath: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!nativeTermux()) throw new TermuxApiError("APK analysis is available only in native Termux.")
      if (!apkPath.trim()) throw new TermuxApiError("Provide an APK file path for analysis.")
      try {
        const { stdout } = await execFileAsync("aapt", ["dump", "badging", apkPath], {
          timeout: TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        })
        return parseAaptBadging(stdout)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new TermuxApiError(
            "APK metadata requires the optional aapt package. Install it with: pkg install aapt",
            error,
          )
        }
        throw new TermuxApiError("aapt could not read this APK. Confirm the file path and APK integrity.", error)
      }
    },
    catch: (error) =>
      error instanceof TermuxApiError ? error : new TermuxApiError("APK metadata analysis failed.", error),
  })

const initializeNow = () => {
  if (!nativeTermux()) throw new TermuxApiError("Termux:API is available only in native Termux.")
}

export const TermuxAPI = {
  initialize: () => Effect.sync(initializeNow),
  initializeNow,
  readSms: () => jsonCommand("termux-sms-list", ["-l", "10"]),
  getBatteryStatus: () => jsonCommand("termux-battery-status"),
  getLocation: () => jsonCommand("termux-location", ["-p", "network"]),
  analyzeApk,
  notify: (title: string, content: string) =>
    command("termux-notification", ["--title", title, "--content", content]).pipe(Effect.asVoid),
  clipboardGet: () => command("termux-clipboard-get"),
  clipboardSet: (text: string) => command("termux-clipboard-set", [text]).pipe(Effect.asVoid),
  toast: (text: string) => command("termux-toast", [text]).pipe(Effect.asVoid),
}
