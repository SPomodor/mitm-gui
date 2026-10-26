# macOS validation record

Date: 2026-10-26. Repository base: `8bd7b288d4a8351923898740af83932005b292ef` (`main`). Working branch: `codex/macos-port`.

Host: Apple Silicon arm64, macOS 15.8.1 (24H32), native Node 24.6.0, Python 3.13.7. Application: mitm gui 0.9.1, Electron 44.7.2, mitmproxy 12.2.3, mitmproxy-rs/mitmproxy-macos 0.12.15, PyInstaller 6.22.3.

This is a local Apple Silicon verification record, not a claim that all macOS targets or the remote workflow have run successfully. Name, SPomodor attribution, ISC license and third-party notices are retained.

## Completed checks

| Check | Result |
| --- | --- |
| `npm ci` and Python dependency installation | Passed on native arm64 |
| `npm run build` | TypeScript and production Vite build passed |
| `npm test -- --junitxml=build/pytest.xml` | **114 passed, 1 skipped**; optional Charles Java importer skipped |
| `npm run test:format` | **5 passed** |
| `npm run test:ui` | **2 passed**, including all translation keys |
| PyInstaller engine build | Passed, native arm64, no cross-compilation |
| Frozen-engine `tests/test_integration.py` | **15 passed** |
| `npm run test:architecture` | Electron and engine arm64; **79 native engine Mach-O files** inspected |
| `codesign --verify --deep --strict` | Passed for the final ad-hoc-signed `.app`; this does not establish Developer ID trust |
| Packaged `smoke-ui.cjs --packaged` | Passed; no renderer errors |
| Packaged `smoke-language.cjs` | Passed; Auto/en/ru, restart, cross-window translation, closing during startup |
| Packaged `smoke-script-editor.cjs --packaged` | Passed; Cmd-select/undo/redo, indentation, both themes, large-script search, applied source and Ctrl+M focus escape |
| Packaged `smoke-macos-lifecycle.cjs` | Passed; Cmd+K, native Quit role present, close hides window, activation restores it, `app.quit()` terminates engine and Python workers |
| Intel dependency availability | Full binary wheel closure for Python 3.13/macOS x86_64 downloaded successfully with `pip download --only-binary=:all:`; no Intel execution |
| Packaging guard checks | Cross-architecture packaging and requested notarization without credentials rejected; Windows hook does nothing |
| Workflow parsing and Windows preservation | YAML parsed; Windows job deep-compared equal to `main`; Windows portable config, branding, author and license unchanged |
| `git diff --check` | Passed |
| Visual review | Light/dark script editor and compact screenshots inspected; existing dense layout preserved |

The full packaged UI suite covers real HTTP/HTTPS capture, selective SSL settings and opaque TLS relay, Rewrite headers/status/body/query, original/result inspection, Map Local/Blocklist, Python script validation/apply/enable/transitions/errors, recording/session behavior, persistent settings, HAR export via the native save dialog, theme synchronization and independent rule editor windows. WireGuard startup/profile/QR is covered; Python tests also exercise synthetic UDP/QUIC/DTLS listeners. None of these tests changes the system proxy or Keychain trust.

Initial socket tests failed inside the execution sandbox because local TCP/UDP bind was forbidden. They were rerun with local network access and passed. The packaged UI test was adapted to quit explicitly on macOS, where closing the window now hides it. Testing found and fixed CodeMirror's macOS Ctrl+M discrepancy. DMG inspection also found that macOS `--prepackaged` needs the `.app` path, rather than its parent directory; the local command, CI and documentation were corrected before final artifact generation.

## Artifacts and reproducibility

Local outputs (excluded from Git):

- `release/mitm-gui-0.9.1-mac-arm64.dmg`
- `release/mitm-gui-0.9.1-mac-arm64.zip`
- `release/SHA256SUMS-mac-arm64.txt`
- `release/mac-arm64/mitm gui.app`

The DMG/ZIP contain the final native app, with an ad-hoc integrity signature, no Developer ID and no notarization. The DMG is checked with `hdiutil verify` and mounted read-only for the lifecycle/engine/worker smoke check. The ZIP is checked for a top-level `mitm gui.app` (no parent build directory). Checksums are written after final generation. Diagnostics are retained locally in `build/macos-validation/`; screenshots are under `build/ui-smoke/`, `build/script-editor-smoke/` and `build/language-smoke/`.

## Remaining verification

- **Intel x64 app:** no Intel Mac is available locally. Binary dependencies are available and a native x64 CI job is configured, but it has not been executed here. No x64 artifact is claimed.
- **Other macOS versions:** only 15.8.1 has run locally. The package floor is 14.0; macOS 14/other releases need execution tests. Electron 44's own minimum is 13.0.
- **Windows:** the entire Windows workflow job and package config are preserved, but Windows binaries/CI cannot be run on this Mac. Shared changes need the existing x64/ARM64 jobs to pass.
- **Apple credentials:** Developer ID signing, hardened-runtime behavior with a real signing identity, notarization, ticket validation and Gatekeeper/quarantine acceptance have not been tested. See [required secrets and commands](macos.md#developer-id-signing-and-notarization).
- **Native interaction:** automation verifies a native Quit role and calls `app.quit()`. CDP events do not dispatch AppKit accelerators. Physical Cmd+Q, Dock clicks, native unsaved-edit prompts and manual Keychain trust setup still require manual release QA. Synthetic activation is tested.
- **Physical devices:** no phone/VPN routing or real LAN/firewall permission flow was tested. WireGuard IPv6 remains limited.
- **System integration:** system proxies and CA trust remain manual user actions. There is no system proxy restoration helper and no local-process/transparent macOS capture UI.
- **Crash/force quit:** normal shutdown and script-worker termination are tested. Force-killing Electron and recovery from host power loss are outside this record.
- **Remote actions:** no push, workflow dispatch or release publication was performed. The new CI must pass on GitHub before calling both architectures release-verified.

Graphify was used for a code-only AST graph (863 nodes, 2017 edges) and a startup/window/backend traversal. Findings were checked against the actual source and project documentation. Generated graphs, virtual environments, capture profiles and artifacts are ignored and are not part of the commit.
