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

## macOS port status

The launcher and engine build script have platform-specific executable paths and native dependency collection. To experiment **on a Mac**, run setup and `npm run package:mac`. This is an unverified port, not a supported release. PyInstaller must freeze the backend on the target OS; a Windows-built backend cannot be reused on macOS.

Before shipping, validate arm64/x64 native dependencies, proxy/WireGuard capture, CA trust, multiprocessing scripts, menu/keyboard behavior and lifecycle on real Macs. Current macOS configuration creates unsigned DMG/ZIP files. Developer ID signing and notarization need separate Apple credentials and configuration; they are not included in Windows CI.

## GitHub Actions

`.github/workflows/build.yml` runs on every branch push, pull request and manual dispatch. It uses Windows, Node 24 and Python 3.13, executes source and frozen-backend tests, packages the app, runs desktop smoke checks and uploads the EXE with a SHA-256 checksum.

Action references are pinned to verified commit SHAs. Ordinary builds have `contents: read`; only the tagged release job receives `contents: write`. Pull requests do not publish releases. No personal token is needed.

The runner must allow Actions. If GitHub disables Actions for the repository, enable the workflow from the Actions tab before requesting a manual build.

## Releases

1. Update `package.json` and regenerate `package-lock.json` with `npm install --package-lock-only`.
2. Commit and push the reviewed changes to `main`.
3. Wait for the branch build to pass.
4. Create and push the exact version tag:

```sh
git tag v0.9.0
git push origin v0.9.0
```

The tag must equal `v` plus `package.json.version`. A tag build repeats all checks, then creates a GitHub Release and uploads the portable EXE and `SHA256SUMS.txt`. A normal push only produces Actions artifacts. The workflow explicitly disables electron-builder's implicit publication.

Do not upload profile data, tokens, WireGuard configurations, CA private keys or real captures. Use synthetic `example.com` fixtures for bug reports and tests.

## Compatibility

The former product name was CHLS. `window.chls`, `CHLS_*` test/launcher environment variables, legacy storage keys, HAR `_chls` fields and `.chls` import remain internal compatibility interfaces. Public branding is mitm gui. The recommended Python import is `mitm_gui`; `chls` is an alias for existing scripts.

## Attribution

mitm gui is **by SPomodor**, developed with the assistance of **OpenAI Codex**. Preserve the ISC license and third-party notices.
