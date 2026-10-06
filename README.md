<div align="center">
<pre>
       ◇      ◇      ◇
       │      │      │
   ╭──────┬──────┬──────╮
   │ PLAN │ BUILD│ CHECK│
   ╰──────┴──────┴──────╯
        ◉  POWER CORE
     NEXUS AGNET ...The Ultimate Powerhouse for Android Automation!
</pre>
</div>
<p align="center">
  <a href="https://github.com/ravipacharpro-jpg/nexus-Official"><img alt="NEXUS Fixed" src="https://img.shields.io/github/v/release/ravipacharpro-jpg/nexus-Official?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/nexus-ai"><img alt="npm" src="https://img.shields.io/npm/v/nexus-ai?style=flat-square" /></a>
  <a href="https://github.com/ravipacharpro-jpg/nexus-Official"><img alt="Repository" src="https://img.shields.io/github/last-commit/ravipacharpro-jpg/nexus-Official?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![NEXUS Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/ravipacharpro-jpg/nexus-Official)

---

### Installation

```bash
# Termux source installer (native Android / no root)
curl -fsSL https://raw.githubusercontent.com/ravipacharpro-jpg/nexus-Official/main/install-termux.sh | bash

# Termux: reload your shell, then start the agent
source ~/.bashrc && nexus

# Linux and PC installer
curl -fsSL https://raw.githubusercontent.com/ravipacharpro-jpg/nexus-Official/main/install.sh | bash

# Pin the latest verified installer-compatible version
curl -fsSL https://raw.githubusercontent.com/ravipacharpro-jpg/nexus-Official/main/install.sh | bash -s -- --version 0.1.90

# Package managers
npm i -g nexus-ai@latest        # or bun/pnpm/yarn
# macOS and Linux: use the install.sh script above, or npm for the CLI
paru -S nexus-bin               # Arch Linux (AUR)
mise use -g nexus               # Any OS
nix run github:ravipacharpro-jpg/nexus-Official   # latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

NEXUS is also available as a desktop application. Download directly from the [official GitHub Releases page](https://github.com/ravipacharpro-jpg/nexus-Official/releases).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `nexus-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `nexus-desktop-mac-x64.dmg`     |
| Windows               | `nexus-desktop-win-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS: download the .dmg/.zip from GitHub Releases (github.com/ravipacharpro-jpg/nexus-Official/releases)
# Windows (Scoop)
scoop bucket add extras; scoop install extras/nexus-desktop
```

> [!NOTE]
> Desktop binaries are signed and notarized on each release; if no assets are
> attached to the latest tag yet, build from source:
> `bun run --cwd packages/desktop package:mac` (or `package:win` / `package:linux`).

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$NEXUS_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.nexus/bin` - Default fallback

```bash
# Examples
NEXUS_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/ravipacharpro-jpg/nexus-Official/main/install.sh | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://raw.githubusercontent.com/ravipacharpro-jpg/nexus-Official/main/install.sh | bash
```

### Agents

NEXUS includes the original interactive agents plus the Master Agent runtime. The terminal-first autonomy layer lives in this repository and does not require a web dashboard.

### Autonomous Master Agent

The Master Agent plans dependency-ordered work, dispatches typed specialists, checkpoints progress, retries bounded failures, creates repair and verification follow-ups, records SHA-256 verification receipts, discovers web/APK artifacts, and persists redacted incidents under `.nexus/`. It supports Termux/Android and PC-oriented resource limits, multi-key provider fallback, managed Chromium lifecycle, secure takeover for login/OTP/CAPTCHA, and approval-gated Android install/launch/logcat plans.

Secrets, passwords, OTPs, payment actions, external Git mutations, browser takeover, and ADB mutations remain approval-gated. Real Android execution requires a connected ADB device or emulator. The full monorepo native typecheck may require more memory than a constrained environment provides; use `bun run typecheck:lowmem` or the serialized focused tests when working on Termux.

NEXUS includes built-in agents you can switch between with the `Tab` key.

- **master** - Default agent; the autonomy runtime that plans, dispatches specialists, and verifies work
- **build** - Full-access agent for direct development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](./docs/master-agent-guide.md).

### Documentation

For more info on how to configure NEXUS, [**head over to the repository documentation**](https://github.com/ravipacharpro-jpg/nexus-Official#readme).

### Contributing

If you're interested in contributing to NEXUS, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on NEXUS

If you are working on a project that's related to NEXUS and is using "nexus" as part of its name, for example "nexus-dashboard" or "nexus-mobile", please add a note to your README to clarify that it is not built by the NEXUS team and is not affiliated with us in any way.

---

**Track issues and releases** on the [repository](https://github.com/ravipacharpro-jpg/nexus-Official)
