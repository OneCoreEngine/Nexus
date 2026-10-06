// Patch an installed @opentui/core package so it can load the local,
// musl-built native library on Android/Termux.
//
// The upstream package does not ship an "android" asset target. At runtime the
// compiled chunks call getNativeAssetDescriptor(getCurrentNodeAssetTarget())
// which throws "Unsupported OpenTUI Node asset target: android-arm64", and
// resolveNativeLibraryPath() ends with a generic unsupported-platform error for
// anything outside darwin/linux/win32.
//
// This patcher (1) registers android in NATIVE_FILE_NAMES and (2) makes
// resolveNativeLibraryPath() return the absolute path to our .so for
// aarch64-linux-android. All other platforms behave exactly as before.
//
// Usage: node patch-opentui-android.js <core-package-dir> <libopentui-path>

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [, , coreDir, libPath] = process.argv
if (!coreDir || !libPath) {
  console.error("usage: node patch-opentui-android.js <core-dir> <libopentui-path>")
  process.exit(1)
}

const NATIVE_FILE_NAMES_ANCHOR = 'win32: "opentui.dll"'
const NATIVE_FILE_NAMES_PATCHED = 'win32: "opentui.dll", android: "libopentui.so"'

const FN_ANCHOR = "async function resolveNativeLibraryPath() {\n  const asset = getNativeAssetDescriptor(getCurrentNodeAssetTarget());"
const FN_PATCHED = `async function resolveNativeLibraryPath() {
  if (process.platform === "android" && process.arch === "arm64") {
    return ${JSON.stringify(libPath)};
  }
  const asset = getNativeAssetDescriptor(getCurrentNodeAssetTarget());`

let anyChanged = false
for (const file of readdirSync(coreDir)) {
  if (!file.startsWith("chunk-")) continue
  const path = join(coreDir, file)
  let source = readFileSync(path, "utf8")
  const next = source
    .replaceAll(NATIVE_FILE_NAMES_ANCHOR, NATIVE_FILE_NAMES_PATCHED)
    .replace(FN_ANCHOR, FN_PATCHED)
  if (next !== source) {
    writeFileSync(path, next)
    console.log(`patched ${file}`)
    anyChanged = true
  }
}
if (!anyChanged) {
  console.error(`no patchable chunks found in ${coreDir}`)
  process.exit(1)
}