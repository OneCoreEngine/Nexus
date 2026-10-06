import open from "open"

const SENSITIVE_QUERY_KEYS =
  /^(access_?token|api_?key|code|credential|key|password|refresh_?token|secret|session|token)$/i

export type BrowserHandoffTarget = {
  launchUrl: string
  origin: string
  hasSensitiveQuery: boolean
}

export type BrowserHandoffLauncher = (url: string) => Promise<void>

export type BrowserPageInspection = {
  url: string
  status: number
  contentType: string
  title?: string
  textPreview: string
}

export type BrowserPageInspectionOptions = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
  maxPreviewChars?: number
  signal?: AbortSignal
}

function isTermuxEnvironment() {
  return process.env.TERMUX_VERSION !== undefined || process.env.PREFIX?.includes("/com.termux/files/usr") === true
}

export function parseBrowserHandoffTarget(input: string): BrowserHandoffTarget {
  const parsed = new URL(input)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("Browser handoff only accepts an explicit http:// or https:// URL")
  const hasSensitiveQuery = [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEYS.test(key))
  if (hasSensitiveQuery) {
    throw new Error("Browser handoff refuses sensitive query parameters; use an origin-only URL")
  }
  return { launchUrl: parsed.toString(), origin: parsed.origin, hasSensitiveQuery: false }
}

export function findSafeBrowserHandoffUrl(patterns: readonly string[]) {
  for (const pattern of patterns) {
    try {
      return parseBrowserHandoffTarget(pattern).launchUrl
    } catch {
      // Permission patterns can contain non-URL paths or sensitive URLs; skip them.
    }
  }
  return undefined
}

export async function inspectPublicBrowserPage(
  input: string,
  options: BrowserPageInspectionOptions = {},
): Promise<BrowserPageInspection> {
  const target = parseBrowserHandoffTarget(input)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(100, options.timeoutMs ?? 8_000))
  try {
    const response = await (options.fetch ?? globalThis.fetch)(target.launchUrl, {
      method: "GET",
      redirect: "manual",
      signal: options.signal ?? controller.signal,
    })
    const contentType = response.headers.get("content-type") ?? ""
    const readable = /(?:text\/|application\/(?:json|xml|javascript))/i.test(contentType)
    const body = readable ? await response.text() : ""
    const limit = Math.max(0, options.maxPreviewChars ?? 4_000)
    const title = body
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim()
    return {
      url: response.url || target.launchUrl,
      status: response.status,
      contentType,
      ...(title ? { title: title.slice(0, 200) } : {}),
      textPreview: body
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function openLocalBrowser(url: string, options: { termuxOpener?: string } = {}) {
  if (isTermuxEnvironment()) {
    const child = Bun.spawn([options.termuxOpener ?? "termux-open-url", url], { stdout: "ignore", stderr: "pipe" })
    const exitCode = await child.exited
    if (exitCode !== 0) {
      const stderr = await new Response(child.stderr).text()
      throw new Error(
        `Unable to open the Android browser with termux-open-url${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      )
    }
    return
  }
  await open(url, { wait: false })
}

export * as BrowserHandoff from "./browser-handoff"
