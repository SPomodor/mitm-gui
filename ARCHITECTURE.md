# Architecture

[README](README.md) · [Build and release](CONTRIBUTING.md) · [Python API](SCRIPTS.md)

## Processes

```text
React renderer (sandboxed, no Node)
    ↕ narrow contextBridge API
Electron main
    ├── native file dialogs, library/preferences, window lifecycle
    ├── authenticated HTTP/WebSocket → 127.0.0.1:<random port>
    └── Python backend child
           ├── FastAPI management API
           ├── mitmproxy DumpMaster + capture addons
           │      ├── HTTP proxy TCP listener
           │      └── WireGuard UDP listener
           ├── SQLite + body files + CA + WireGuard profile
           └── disposable Python process per applied script revision
```

Electron owns the backend lifecycle. A random per-launch token stays in the main process; the renderer calls an allowlisted IPC API. Backend management only listens on loopback. Capture listeners may allow LAN access independently. The renderer does not process each proxied network message.

IPC senders and frames are checked. External navigation and new windows are denied. Captured content is rendered as text, not executed HTML. Rule editors are separate sandboxed BrowserWindows, registered by rule ID and sharing the same backend.

## Source map

| File | Responsibility |
| --- | --- |
| `electron/main.cjs` | Backend startup, IPC, events, dialogs, windows, preferences |
| `electron/preload.cjs` | Restricted renderer bridge |
| `electron/script-library.cjs` | Atomic text-only library persistence |
| `src/App.tsx` | Shell, traffic, inspector, rules, connection setup |
| `src/Mocks.tsx` | Script library/editor controls, live state and logs |
| `src/ScriptEditor.tsx` | Lazy-loaded CodeMirror Python editor/search |
| `src/RewriteFields.tsx` | Rewrite action forms |
| `src/PaneResize.tsx` | Pointer/keyboard resizing and persisted layout |
| `src/VirtualCode.tsx`, `src/SearchBody.tsx` | Bounded body rendering and search |
| `src/i18n.ts`, `electron/locales/en.json` | Live shared language preference/catalog |
| `backend/__main__.py` | FastAPI API, mitmproxy capture lifecycle/hooks |
| `backend/store.py` | Sessions, SQLite records and body files |
| `backend/rules.py`, `backend/rewrite.py` | Validated rule matching and transformations |
| `backend/ssl_policy.py`, `backend/tunnels.py` | TLS routing and opaque connection observation |
| `backend/records.py`, `backend/har.py`, `backend/charles_har.py` | Record normalization and HAR export |
| `backend/scripts.py` | Worker supervision, revisions, scope and atomic execution |
| `backend/script_worker.py` | Python compilation, fixture snapshots, handler dispatch |
| `backend/script_api.py`, `backend/json_fields.py` | Script API and shared JSON selectors |
| `backend/script_migration.py`, `backend/mocks.py` | One-way legacy document migration |

## Capture and persistence

Recording is independent of listeners and rules. At request start, the engine captures the recording decision, session and session generation. Clear/delete advances the generation; late responses cannot recreate deleted history. Existing recorded requests can finish after recording is paused.

Sessions archive on normal close or when superseded. Startup archives leftovers after a crash and creates a fresh recording session. The GUI can browse an archive while the engine records into the current session. Export is a consistent snapshot independent of display filters.

HTTP and encrypted connections have separate record shapes. Opaque TLS/DTLS/QUIC records never pretend to contain HTTP methods, paths or bodies. Standard HAR emits HTTP only; the optional Charles mode creates explicit synthetic CONNECT summaries.

## SSL routing

SSL scope combines a master toggle with all/selected hosts, ports, wildcards, CONNECT destination and SNI. Opaque routing chooses a relay before native TLS interception. When needed, ClientHello inspection is bounded to 64 KiB/128 events. Observation does not decrypt or delay application content indefinitely.

A connection keeps its chosen mode. Settings changes only affect new connections. HTTP paths cannot participate in pre-decryption routing.

## Rules and scripts

Rules use immutable validated revisions. Original request location is captured before mutations. Request handlers/rules operate before upstream forwarding; local Map Local/Blocklist/script responses terminate ordinary request processing. For forwarded replies, normal response Rewrite precedes script response callbacks. Script-local replies skip normal response Rewrite.

A script revision owns a spawned Python worker and immutable fixture snapshot. Parent-owned managed contexts are keyed per request. Worker transactions return candidate messages and JSON state; the parent validates them before committing. Errors preserve the previous managed state/message. Python side effects outside those managed values are not transactional.

Workers have startup/handler timeouts and a parent-death watcher. Stop is committed only on successful execution and disables the revision globally. Pending requests check stop under the execution lock. Reapplying creates a new revision; old in-flight responses do not run the new revision's callbacks.

The library is independent from the engine. Saving text never compiles or activates it. Applying compiles, installs and saves; selecting a library item does not alter active capture behavior.

## UI state and language

Zustand holds live status, sessions, flows and rules; backend events refresh or merge bounded lists. Per-editor drafts remain local. CodeMirror and large bodies are virtualized, and script editor loading is deferred until first use.

Language comes from an Electron-owned persisted preference and OS locale. The renderer receives its initial locale before rendering, subscribes to preference changes and updates all open windows. Only UI-owned messages are localized; request bodies, source and user names remain data.

## Compatibility boundaries

The public name is **mitm gui**, by SPomodor. CHLS is the former name. Existing profiles are reused when found. `window.chls`, `CHLS_*` launcher/test variables, local-storage keys and HAR `_chls` fields remain stable internal compatibility formats. `mitm_gui` is the recommended public Python module, with `chls` retained as an alias.

## Distribution

Node scripts bootstrap a local Python environment, compile the frontend, freeze the backend with PyInstaller and package it with electron-builder. Windows CI runs both source and frozen-backend tests plus packaged GUI smoke tests. Tags matching the package version publish release assets after those checks pass. macOS CI builds native arm64 and x64 engines on matching Mac runners, checks Mach-O architectures and tests the packaged application before DMG/ZIP generation. The local verification record and signing boundaries are in [docs/macos.md](docs/macos.md). On macOS, closing the main window hides it while Quit owns engine termination.
