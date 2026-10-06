#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

# NEXUS Termux installer for ravipacharpro-jpg/nexus-Official.
# Installs the source tree and runs the CLI with Bun, which avoids relying on
# Linux/glibc release binaries that do not run natively on Android/Termux.

REPO_URL="${NEXUS_REPO_URL:-https://github.com/ravipacharpro-jpg/nexus-Official.git}"
INSTALL_ROOT="${NEXUS_HOME:-$HOME/.nexus}"
SOURCE_DIR="$INSTALL_ROOT/source"
BIN_DIR="${NEXUS_BIN_DIR:-$HOME/bin}"
LAUNCH="${NEXUS_LAUNCH:-0}"
INSTALL_SERVICES="${NEXUS_SERVICES:-0}"

say() { printf '\n[NEXUS] %s\n' "$*"; }
die() { printf '\n[NEXUS] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ] && command -v pkg >/dev/null 2>&1 \
  || die "Run this installer inside the native Termux app."

if ! apt-get --version >/dev/null 2>&1; then
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64) deb_arch="aarch64" ;;
    armv7l|arm) deb_arch="arm" ;;
    x86_64|amd64) deb_arch="x86_64" ;;
    i686|x86) deb_arch="i686" ;;
    *) deb_arch="$arch" ;;
  esac
  die "Termux pkg/apt is broken (often missing liblz4). Repair it first with: curl -LO https://packages.termux.dev/apt/termux-main/pool/main/libl/liblz4/liblz4_1.10.0-1_${deb_arch}.deb && dpkg -i liblz4_1.10.0-1_${deb_arch}.deb && pkg update -y"
fi

say "Updating Termux packages"
pkg update -y
pkg install -y bash ca-certificates curl git unzip tar nodejs-lts

if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun runtime"
  pkg install -y bun || die "Bun is not available in this Termux repository. Run 'pkg update && pkg install bun', then retry."
fi
command -v bun >/dev/null 2>&1 || die "Bun installation failed."

say "Downloading NEXUS source"
mkdir -p "$INSTALL_ROOT"
if [ -d "$SOURCE_DIR/.git" ]; then
  git -C "$SOURCE_DIR" fetch --depth=1 origin main \
    || die "Could not fetch branch 'main' from $REPO_URL. Check the URL and your connection."
  git -C "$SOURCE_DIR" reset --hard origin/main \
    || die "Could not reset to origin/main."
else
  rm -rf "$SOURCE_DIR"
  git clone --depth=1 --branch main "$REPO_URL" "$SOURCE_DIR" \
    || die "Could not clone branch 'main' from $REPO_URL. Check the URL and your connection, or set NEXUS_REPO_URL to a repo that has a main branch."
fi

say "Installing JavaScript dependencies (this may take a few minutes)"
cd "$SOURCE_DIR"
# Termux repositories can ship a newer Bun than the lockfile writer. Prefer
# the frozen install, but fall back to a normal install when Bun reports only
# a lockfile-format or lockfile-resolution change.
if ! bun install --frozen-lockfile; then
  say "Bun lockfile differs on this runtime; retrying without frozen mode"
  if ! bun install; then
    say "A native dependency build failed; retrying without lifecycle scripts"
    bun install --ignore-scripts
    printf '%s\n' '[NEXUS] Warning: native optional helpers were skipped; the core agent is installed.'
  fi
fi

# @ff-labs/fff-bun ships Linux/macOS/Windows binaries only. On Android its
# package is skipped, so provide a safe no-op module rather than crashing at
# startup; the agent remains usable without native fast file indexing.
FFF_DIR="$SOURCE_DIR/node_modules/@ff-labs/fff-bun"
if [ ! -e "$FFF_DIR/package.json" ]; then
  say "Enabling Termux file-search fallback"
  mkdir -p "$FFF_DIR"
  cat > "$FFF_DIR/package.json" <<'JSON'
{"name":"@ff-labs/fff-bun","version":"0.9.4","type":"module","main":"index.js"}
JSON
  cat > "$FFF_DIR/index.js" <<'JS'
export const FileFinder = {
  isAvailable() { return false },
  create() { return { ok: false, error: "Native file indexing is unavailable on Android/Termux" } },
}
JS
fi

# OpenTUI's native renderer library (@opentui/core) ships no android-arm64
# binary. We build one for aarch64-linux-musl in CI and attach it to releases
# (see .github/workflows/opentui-android.yml). Place it on disk and teach the
# bundled JS to load it instead of throwing on an unsupported platform.
OPENTUI_LIB="$INSTALL_ROOT/opentui/libopentui.so"
if [ ! -f "$OPENTUI_LIB" ]; then
  say "Installing OpenTUI native renderer for Android"
  mkdir -p "$INSTALL_ROOT/opentui"
  OPENTUI_LIB_URL="${OTUI_LIB_URL:-}"
  if [ -z "$OPENTUI_LIB_URL" ]; then
    OPENTUI_LIB_URL="https://github.com/${REPO_URL#https://github.com/}/releases/latest/download/opentui-lib-musl-arm64.tar.gz"
    OPENTUI_LIB_URL="${OPENTUI_LIB_URL%.git}"
  fi
  if curl -fsSL "$OPENTUI_LIB_URL" -o "$INSTALL_ROOT/opentui.tar.gz" \
    && tar -xzf "$INSTALL_ROOT/opentui.tar.gz" -C "$INSTALL_ROOT/opentui" \
    && cp "$INSTALL_ROOT/opentui/musl-arm64/libopentui.so" "$OPENTUI_LIB" \
    && cp "$INSTALL_ROOT/opentui/musl-arm64/libotui-shim.so" "$INSTALL_ROOT/opentui/libotui-shim.so"; then
    rm -f "$INSTALL_ROOT/opentui.tar.gz"
    rm -rf "$INSTALL_ROOT/opentui/musl-arm64"
  else
    say "Warning: could not fetch OpenTUI native lib from $OPENTUI_LIB_URL (UI rendering disabled)"
    rm -f "$INSTALL_ROOT/opentui.tar.gz"
  fi
fi
if [ -f "$OPENTUI_LIB" ]; then
  CORES=()
  for d in "$SOURCE_DIR"/node_modules/.bun/@opentui+core@*/node_modules/@opentui/core; do
    [ -d "$d" ] && CORES+=("$d")
  done
  for core_dir in "${CORES[@]}"; do
    node "$SOURCE_DIR/script/patch-opentui-android.js" "$core_dir" "$OPENTUI_LIB" >/dev/null 2>&1 \
      && say "Patched OpenTUI runtime for Android in $core_dir" \
      || say "Warning: could not patch $core_dir (OpenTUI UI may fail)"
  done
fi

say "Installing the nexus command"
mkdir -p "$BIN_DIR" "$HOME/.nexus/bots" "$HOME/.nexus/tools" "$HOME/.nexus/services" "$HOME/.nexus/logs" "$HOME/.nexus/agents"
cat > "$BIN_DIR/nexus" <<'LAUNCHER'
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
export TMPDIR="${TMPDIR:-$PREFIX/tmp}"
mkdir -p "$TMPDIR"
SOURCE_DIR="${NEXUS_HOME:-$HOME/.nexus}/source"
NEXUS_LIB_DIR="${NEXUS_HOME:-$HOME/.nexus}/opentui"
[ -d "$SOURCE_DIR" ] || { printf '%s\n' 'NEXUS source is missing. Re-run install-termux.sh.' >&2; exit 1; }
# Auto-start the zen-bridge (free OpenCode Zen tier via local `opencode serve`)
# if it is not already running. The bridge also spawns serve itself.
BRIDGE_URL="${ZEN_BRIDGE_URL:-http://127.0.0.1:4897}"
if [ -f "$HOME/.nexus/bin/zen-bridge.ts" ] && ! curl -sf --max-time 2 "$BRIDGE_URL/v1/models" >/dev/null 2>&1; then
  if command -v setsid >/dev/null 2>&1; then
    setsid -f bun "$HOME/.nexus/bin/zen-bridge.ts" >/dev/null 2>>"$TMPDIR/zen-bridge.log" &
  else
    nohup bun "$HOME/.nexus/bin/zen-bridge.ts" >/dev/null 2>>"$TMPDIR/zen-bridge.log" &
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf --max-time 2 "$BRIDGE_URL/v1/models" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# Auto-start the nexus-router bridge (multi-key failover gateway) if it is
# installed and not already running. It lazily spawns the router itself.
ROUTER_URL="${NEXUS_ROUTER_URL:-http://127.0.0.1:4898}"
if [ -f "$HOME/.nexus/bin/nexus-router-bridge.ts" ] && ! curl -sf --max-time 2 "$ROUTER_URL/v1/models" >/dev/null 2>&1; then
  if command -v setsid >/dev/null 2>&1; then
    setsid -f bun "$HOME/.nexus/bin/nexus-router-bridge.ts" >/dev/null 2>>"$TMPDIR/nexus-router-bridge.log" &
  else
    nohup bun "$HOME/.nexus/bin/nexus-router-bridge.ts" >/dev/null 2>>"$TMPDIR/nexus-router-bridge.log" &
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf --max-time 2 "$ROUTER_URL/v1/models" >/dev/null 2>&1 && break
    sleep 1
  done
fi

# libopentui.so needs the bionic-compat shim and libm resolvable at dlopen time.
export LD_LIBRARY_PATH="${NEXUS_LIB_DIR}:${LD_LIBRARY_PATH:-}"
cd "$SOURCE_DIR"
exec bun run --cwd packages/nexus --conditions=browser src/index.ts "$@"
LAUNCHER
chmod 755 "$BIN_DIR/nexus"

# Install the local zen-bridge and configure the free OpenCode Zen provider.
# The bridge turns the device's own `opencode serve` into an
# OpenAI-compatible endpoint so Nexus can use Zen free-tier models.
BRIDGE_SRC="$SOURCE_DIR/.nexus/scripts/zen-bridge.ts"
if [ -f "$BRIDGE_SRC" ]; then
  mkdir -p "$HOME/.nexus/bin" "$HOME/.config/nexus" "$HOME/.local/share/nexus"
  cp "$BRIDGE_SRC" "$HOME/.nexus/bin/zen-bridge.ts"
  chmod 755 "$HOME/.nexus/bin/zen-bridge.ts"
  # Default global config: zen-free provider + default model, only when absent.
  if [ ! -f "$HOME/.config/nexus/nexus.jsonc" ]; then
    cat > "$HOME/.config/nexus/nexus.jsonc" <<'CONF'
{
  "$schema": "https://nexus.ai/config.json",
  "model": "zen-free/big-pickle",
  "provider": {
    "zen-free": {
      "name": "OpenCode Zen Free",
      "api": "http://127.0.0.1:4897/v1",
      "models": {
        "big-pickle": {},
        "mimo-v2.5-free": {},
        "deepseek-v4-flash-free": {},
        "claude-fable-5": {},
        "claude-sonnet-4-6": {}
      }
    }
  }
}
CONF
  fi
  # Merge a zen-free placeholder key into the auth store (only when missing).
  bun -e '
const { readFileSync, writeFileSync } = require("fs")
const auth = process.argv[1]
let j = {}
try { j = JSON.parse(readFileSync(auth, "utf8")) } catch {}
if (!j["zen-free"]) {
  j["zen-free"] = { type: "api", key: "zen-bridge-token" }
  writeFileSync(auth, JSON.stringify(j, null, 2) + "\n")
}
' "$HOME/.local/share/nexus/auth.json"
  say "Zen bridge installed (free tier models: big-pickle, mimo-v2.5-free, ...)"
fi

# Optional: register the bridge as a termux-services daemon so it survives
# Termux restarts without needing a manual `nexus` launch first.
if [ "$INSTALL_SERVICES" = "1" ]; then
  SERVICE_SRC="$SOURCE_DIR/.nexus/scripts/termux-services/zen-bridge/run"
  SERVICE_DST="$PREFIX/var/service/zen-bridge/run"
  if [ -f "$SERVICE_SRC" ] && [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/var/service" ]; then
    mkdir -p "$(dirname "$SERVICE_DST")"
    cp "$SERVICE_SRC" "$SERVICE_DST"
    chmod 755 "$SERVICE_DST"
    rm -f "$(dirname "$SERVICE_DST")/down"
    if command -v sv >/dev/null 2>&1; then
      sv up zen-bridge >/dev/null 2>&1 || true
    fi
    say "zen-bridge service enabled at $SERVICE_DST (auto-starts with Termux). Manage: sv status zen-bridge | sv down zen-bridge"
  else
    say "Skipped service install: termux-services not ready (pkg install termux-services)."
  fi
fi

case ":${PATH}:" in
  *:"$BIN_DIR":*) ;;
  *)
    printf '\n# NEXUS Termux\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$HOME/.bashrc"
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

say "Installation complete"
printf 'Run: source ~/.bashrc && nexus\n'
printf 'Source: %s\n' "$SOURCE_DIR"
printf 'Launcher: %s/nexus\n' "$BIN_DIR"

if [ "$LAUNCH" = "1" ]; then
  exec "$BIN_DIR/nexus"
fi
