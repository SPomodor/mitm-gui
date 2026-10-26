# Contributing and building

[README](README.md) · [Architecture](ARCHITECTURE.md)

## Requirements

Use Node.js 24, Python 3.13 and Git. Windows x64 is the verified build target. On other systems, Python and native mitmproxy wheels must match the target architecture.

```sh
npm run setup
npm run dev
```

`npm run setup` creates a project `.venv`, installs `requirements-dev.txt` and runs `npm ci`. Set `PYTHON` to an alternative Python executable before setup if needed. Do not commit `.venv`, `node_modules` or generated artifacts.

## Checks

```sh
npm run build
npm test
npm run test:format
npm run test:ui
```

The Python suite opens real local TCP/UDP listeners in isolated temporary directories. Charles Java importer verification is optional and skipped unless `CHLS_TEST_CHARLES_JAR` is supplied. It is not required to build the application.

Use the existing UI components and tokens, preserve keyboard navigation, and keep user traffic rendered as text. Check both languages and themes when changing UI. Translation keys live in source; English translations are in `electron/locales/en.json` and checked by `tests/i18n.test.mjs`.

## Windows package

```sh
npm run package
```

This runs frontend compilation, freezes `backend/entry.py` with PyInstaller and packages a portable executable. Output: `release/mitm-gui-<version>-win-x64.exe`.

For debugging individual stages:

```sh
npm run build
npm run build:engine
npx electron-builder --win --dir --publish never
node scripts/smoke-ui.cjs --packaged
node scripts/smoke-language.cjs
node scripts/smoke-script-editor.cjs --packaged
npx electron-builder --win portable --prepackaged release/win-unpacked --publish never
```

To run integration tests against the frozen engine in PowerShell:

```powershell
$env:CHLS_TEST_ENGINE = (Resolve-Path runtime/mitm-gui-engine/mitm-gui-engine.exe).Path
.venv/Scripts/python.exe -m pytest tests/test_integration.py -q
```

Smoke tests create isolated profiles; they do not modify the user's normal capture data. `CHLS_SMOKE_BUILD_DIR` overrides the default `release` directory.

## macOS native builds

See [macOS build, installation and signing](docs/macos.md) ([Русский](docs/macos.ru.md)) and the [validation record](docs/macos-validation.md). Separate arm64/x64 engines must be frozen on a Mac of the same architecture. `npm run package:mac` produces DMG and ZIP; the before-pack hook rejects a mismatched engine. Local verification currently covers Apple Silicon on macOS 15.8.1; Intel execution is pending CI. The configured deployment floor of macOS 14 has not been separately tested.

Unsigned builds receive an ad-hoc integrity signature. Set `CSC_LINK`/`CSC_KEY_PASSWORD` for Developer ID signing and `MITM_GUI_NOTARIZE=true` plus the Apple credentials documented in the guide for notarization. Do not commit credentials. Native menu and Dock behavior preserve the macOS convention: close hides the main window; Quit terminates capture.

## GitHub Actions

`.github/workflows/build.yml` runs on every branch push, pull request and manual dispatch. It uses Windows x64/ARM64 and macOS arm64/x64 runners, Node 24 and Python 3.13. It executes source and frozen-backend tests, packages each app, runs desktop smoke checks and uploads EXE or DMG/ZIP artifacts with architecture-specific SHA-256 checksums. macOS runners use native Python of the same architecture as Electron; Windows ARM64 keeps its x64 engine.

Action references are pinned to verified commit SHAs. Ordinary builds have `contents: read`; only the tagged release job receives `contents: write`. Pull requests do not publish releases. No personal token is needed.

The runner must allow Actions. If GitHub disables Actions for the repository, enable the workflow from the Actions tab before requesting a manual build.

## Releases

1. Update `package.json` and regenerate `package-lock.json` with `npm install --package-lock-only`.
2. Commit and push the reviewed changes to `main`.
3. Wait for the branch build to pass.
4. Create and push the exact version tag:

```sh
git tag v0.9.2
git push origin v0.9.2
```

The tag must equal `v` plus `package.json.version`. A tag build repeats all checks, then creates a GitHub Release and uploads Windows EXEs, macOS DMG/ZIP files and per-platform/architecture SHA256SUMS files after both operating systems pass. A normal push only produces Actions artifacts. The workflow explicitly disables electron-builder's implicit publication.

Do not upload profile data, tokens, WireGuard configurations, CA private keys or real captures. Use synthetic `example.com` fixtures for bug reports and tests.

## Compatibility

The former product name was CHLS. `window.chls`, `CHLS_*` test/launcher environment variables, legacy storage keys, HAR `_chls` fields and `.chls` import remain internal compatibility interfaces. Public branding is mitm gui. The recommended Python import is `mitm_gui`; `chls` is an alias for existing scripts.

## Attribution

mitm gui is **by SPomodor**, developed with the assistance of **OpenAI Codex**. Preserve the ISC license and third-party notices.

## Windows ARM64 hybrid build

CI has two matrix entries: `windows-latest` with x64 Node, and `windows-11-arm`
with ARM64 Node. Both explicitly use **x64 Python 3.13**. This is intentional:
mitmproxy-rs and its current native dependencies do not provide a complete Windows ARM64 wheel set.
The ARM64 Electron process starts the x64 backend using Windows 11 emulation.
HTTP proxy and WireGuard modes do not require the bundled x64 local-capture driver.

`MITM_GUI_TARGET_ARCH` selects `x64` or `arm64` for packaging checks and smoke tests.
The PE-header check verifies the actual frontend architecture and requires an x64 engine;
it does not infer architecture from filenames. Release publishing waits for both matrix jobs.
Artifacts and SHA-256 files are named per architecture and merged for the tagged release.

To cross-package an ARM64 interface from Windows x64 (execution testing still requires ARM64 Windows):

```powershell
npm run build
npm run build:engine
$env:MITM_GUI_TARGET_ARCH = 'arm64'
npx electron-builder --win --arm64 --dir --publish never
npm run test:architecture
npx electron-builder --win portable --arm64 --prepackaged release/win-arm64-unpacked --publish never
```

Do not label this as fully native ARM64. Do not add an ia32 target: Electron 44
has no such runtime and the current mitmproxy Rust wheel is x64-only on Windows.
