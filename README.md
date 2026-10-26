# mitm gui

**by SPomodor** · **[Русская версия](README.ru.md)**

[![Build and test](https://github.com/SPomodor/mitm-gui/actions/workflows/build.yml/badge.svg)](https://github.com/SPomodor/mitm-gui/actions/workflows/build.yml)

A desktop **mitmproxy GUI** for inspecting HTTP(S) traffic, connecting phones through WireGuard, rewriting requests and responses, and running Python scripts.

Built by **SPomodor with the assistance of OpenAI Codex**. This is an independent project, not an official mitmproxy product.

## Download

**[Download a release](https://github.com/SPomodor/mitm-gui/releases)** · [CI builds](https://github.com/SPomodor/mitm-gui/actions/workflows/build.yml)

Choose **Windows x64** (`mitm-gui-<version>-win-x64.exe`) or **Windows ARM64 hybrid** (`mitm-gui-<version>-win-arm64.exe`). No separate Python or Node.js installation is required. If no release has been published yet, open a successful Actions run and download the matching `mitm-gui-windows-x64` or `mitm-gui-windows-arm64` artifact.

Builds are currently unsigned; Windows may show an unknown-publisher warning. macOS is not yet verified: native build commands are provided for porting, but the Windows workflow does not produce a Mac application.

## Windows architectures

| Build | Runtime | Status |
| --- | --- | --- |
| x64 | x64 interface and x64 engine | Supported |
| ARM64 | Native ARM64 interface + x64 engine under Windows emulation | Hybrid; requires Windows 11 on ARM64 |
| x86 / 32-bit | — | Unavailable with the current Electron/mitmproxy stack |

ARM64 releases are explicitly hybrid: the network engine is not native ARM64.
The same proxy, WireGuard and script integration tests run on a Windows ARM64 runner before publishing.
Windows 10 ARM and 32-bit ARM are not supported. Electron 44 removed Windows ia32 builds;
mitmproxy-rs currently publishes Windows wheels for x64 only.

## Features

- HTTP/HTTPS proxy and WireGuard with phone setup instructions and a QR code.
- Selective SSL decryption by domain, wildcard, IP and optional port.
- Encrypted connection history with addresses, timing and byte counts.
- Request/response inspector, JSON/text search, original and modified versions, body download.
- Rewrite rules for headers, query parameters, destination, URL, path, status, bodies and JSON fields.
- Map Local, Blocklist, ordered rules and independent rule editor windows.
- Python scripts with conditions, variables, request/response handlers and optional scenario states.
- Script library with save, duplicate, rename, search, `.py` import/export and syntax highlighting.
- Session archives and HAR export, including optional Charles connection summaries.
- Resizable panes, light/dark themes and English/Russian UI with automatic language selection.

## Quick start

1. Launch the app. HTTP capture and traffic recording start with the saved settings.
2. Open **Connect device** and choose HTTP proxy or WireGuard.
3. For HTTPS, install the CA from `mitm.it` on the device and enable trust.
4. Open your app or website; requests appear in **Traffic**.
5. Open **Scripts → Example**, apply and enable it, then request `http://example.com/api/hello` through the proxy.

**Recording** controls history storage. **Capture** starts/stops listeners. The app does not automatically change the system proxy, firewall or CA trust. Applied scripts start disabled after restarting.

## Documentation

| Guide | English | Русский |
| --- | --- | --- |
| App, device setup, SSL, rules and history | [Application guide](docs/application.md) | [Руководство приложения](docs/application.ru.md) |
| Python API, JSON helpers and scenarios | [Scripting guide](SCRIPTS.md) | [Документация скриптов](docs/scripts.ru.md) |
| Process boundaries and implementation | [Architecture](ARCHITECTURE.md) | — |
| Development, CI and releases | [Contributing](CONTRIBUTING.md) | — |

## Develop locally

Requirements: **Node.js 24**, **Python 3.13** and Git. Run from the repository root:

```sh
git clone https://github.com/SPomodor/mitm-gui.git
cd mitm-gui
npm run setup
npm run dev
```

Setup creates `.venv`, installs Python dependencies and PyInstaller, and runs `npm ci`. Development uses Vite, Electron and the Python backend from `.venv`.

```sh
npm run build          # TypeScript check and production frontend
npm test               # Python unit and integration tests
npm run test:format    # JSON body formatting tests
npm run test:ui        # Translation catalog and library persistence tests
npm run package        # Windows portable app with bundled Python engine
```

The EXE is written to `release/`. Build output, dependencies, private keys and captured traffic are excluded from Git.

## Build on GitHub

Every push and pull request runs [Build and test](.github/workflows/build.yml) on Windows x64 and ARM64: frontend/backend tests, a frozen Python engine, real proxy integration checks, packaged desktop smoke tests and portable packaging.

- Download `mitm-gui-windows-x64` from a successful run's **Artifacts** section.
- Use **Actions → Build and test → Run workflow** for a manual build.
- Push a tag matching `package.json`, such as `v0.9.2`, to publish a GitHub Release after all checks pass. The release includes Windows x64/ARM64 EXEs, macOS arm64/x64 DMG/ZIP files and architecture-specific SHA-256 checksums.

The workflow uses the built-in `GITHUB_TOKEN`; no personal access token or signing secret is required for the unsigned Windows build. See [release instructions](CONTRIBUTING.md#releases).

## Limits and data

Use the tool with apps, devices and traffic you are authorized to inspect. Captures can contain credentials and personal data: do not attach real HAR files, private CA keys, WireGuard profiles or production tokens to public issues.

HTTPS inspection requires CA trust. Certificate pinning needs a debug configuration in your own app. Without decryption, HTTPS paths and bodies are unavailable. UDP/QUIC/DTLS capture is experimental; WireGuard IPv6 support is limited. Python scripts have filesystem/system access; validation executes top-level code.

The project was previously named CHLS. Existing profiles and `from chls import ...` scripts remain compatible; new scripts use `from mitm_gui import ...`.

## Credits and license

**by SPomodor**. Developed with the assistance of **OpenAI Codex**.

[ISC license](LICENSE). Third-party components retain their own licenses; see [NOTICE](NOTICE). The network engine is provided by [mitmproxy](https://github.com/mitmproxy/mitmproxy).

## macOS

Separate Apple Silicon (arm64) and Intel (x64) DMG/ZIP packages include native engines. Local verification covers macOS 15.8.1 on Apple Silicon; Intel execution awaits CI. Packaging requires macOS 14 or later, but macOS 14 has not been separately tested. Without Apple credentials builds have only an ad-hoc signature and are not notarized.

[Installation, builds, proxy, Keychain and signing](docs/macos.md) · [Validation record](docs/macos-validation.md). Closing the window keeps capture running in the Dock; Cmd+Q quits. System proxy and CA trust setup/restoration remain explicit user actions.
