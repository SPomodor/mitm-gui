# macOS build and installation

[README](../README.md) · [Русский](macos.ru.md) · [Build instructions](../CONTRIBUTING.md)

**mitm gui — by SPomodor. ISC license.**

The macOS port produces separate **arm64** (Apple Silicon) and **x64** (Intel) applications, each with a native Python engine. There is no hybrid or universal macOS build. Build on a Mac of the target architecture: PyInstaller cannot cross-compile between operating systems, and this project deliberately rejects cross-architecture packaging.

Local verification for this change uses **macOS 15.8.1 on Apple Silicon**. Intel binary dependency downloads were checked, but Intel execution awaits the x64 CI job. The packaging floor is **macOS 14**; macOS 14 itself has not been tested. Electron 44 declares macOS 13 as its minimum; this project chooses a narrower deployment range. Do not treat an unexecuted CI configuration as verified support. See [the validation record](macos-validation.md).

## Install

Choose `mitm-gui-<version>-mac-arm64.dmg` for Apple Silicon or `...-mac-x64.dmg` for Intel. Mount the DMG, drag **mitm gui.app** to Applications, eject the image, and launch from Applications. ZIP archives contain the same complete application bundle. Do not extract or move the engine separately. Node.js, Python and Rosetta are unnecessary for a matching native build.

Verify downloads against `SHA256SUMS-mac-<arch>.txt` with `shasum -a 256`. Without Apple credentials, builds use an **ad-hoc signature for bundle integrity**, with no verified publisher and no notarization. Gatekeeper can block a downloaded copy. After checking its source and checksum, attempt to open it and use **System Settings → Privacy & Security → Open Anyway**, if permitted by your Mac's policy. Do not globally disable Gatekeeper. A managed Mac may require an administrator. Locally built copies do not test the quarantine behavior of downloaded artifacts.

## Proxy and certificates

The app does **not** modify the system proxy, restore proxy settings, install certificates or grant CA trust. Configuration remains an explicit user action.

For capture from this Mac:

1. Start the app's HTTP listener. Note its port (default `8080`).
2. In System Settings → Network → your active network service → Details → Proxies, record the previous configuration. Configure **Web Proxy (HTTP)** and **Secure Web Proxy (HTTPS)** to `127.0.0.1` and the HTTP listener port. Leave proxy authentication off. The HTTPS proxy entry uses the same ordinary HTTP CONNECT listener.
3. Alternatively, configure only a test browser/client, or run `curl --proxy http://127.0.0.1:8080 http://example.com/`.
4. For HTTPS, click **Save CA**, import that public certificate into **Keychain Access** (login keychain), inspect the mitmproxy certificate, and explicitly set its **Secure Sockets Layer (SSL)** trust to **Always Trust**. macOS may request authentication. Use the CA from your own profile only. The app never grants trust on your behalf.
5. Enable SSL decryption for the required hosts. Reconnect clients after scope changes.
6. **Before quitting or stopping capture, restore the previous HTTP/HTTPS proxy settings.** Otherwise those clients may lose network access. Remove the imported CA/reset its trust when finished. Do not delete unrelated certificates.

A CA file ending in `.cer` is PEM-encoded. Command-line clients can use `--cacert /path/to/mitm-gui-ca.cer` instead of changing Keychain trust. Integration tests use a temporary CA and never change your keychains.

For phone capture, use a reachable LAN address, enable LAN access and follow the existing Android/iPhone instructions. macOS may prompt for local-network or firewall access; only allow it on networks you intend to use.

## WireGuard and platform limits

The bundled mitmproxy WireGuard endpoint listens on UDP (default `51820`) and produces a profile/QR for **one external device at a time**. It does not require an installed server, root privileges or a privileged helper. Local tests cover listener startup, profile generation and the existing synthetic UDP/QUIC/DTLS checks. A physical phone and its VPN routing have not been tested here.

The app exposes HTTP proxy and WireGuard modes. It does not expose macOS local-process/transparent capture or install mitmproxy's redirector as a system extension. The bundled native support package does not imply these modes are enabled. IPv6 WireGuard capture remains limited. Another VPN, firewall or Wi-Fi isolation may block connectivity. Ports below 1024 can require elevated privileges; prefer the defaults and do not run the entire application as root.

## Desktop behavior and storage

Native traffic-light controls and the normal macOS title bar remain intact. The existing brand region is draggable. Closing the main window hides it and keeps capture running; clicking the Dock icon restores it. **mitm gui → Quit / Cmd+Q** closes editors, archives the session and terminates the engine. Unsaved script edits retain the save/discard prompt on quit. Cmd+K searches traffic, Cmd+F searches bodies/scripts, Cmd+S saves, and normal Edit-menu copy/paste/undo work. Ctrl+M then Tab leaves the script editor; native CodeMirror Option+Shift+M also works. Both languages and themes are retained.

New profiles use `~/Library/Application Support/mitm-gui`; legacy CHLS profiles are reused when present. The engine log is `engine/engine.log` inside that profile. Captures, private CA keys and WireGuard secrets stay in the profile, outside the read-only application bundle. Back up only with the app closed.

## Build and verify

Use native **Node 24**, **Python 3.13** and Xcode Command Line Tools. Ensure Node and Python match the target Mac architecture; set `PYTHON` before setup if needed.

```sh
PYTHON=python3.13 npm run setup
npm run build
npm test
npm run test:format
npm run test:ui
npm run build:engine
CHLS_TEST_ENGINE="$PWD/runtime/mitm-gui-engine/mitm-gui-engine" .venv/bin/python -m pytest tests/test_integration.py -q
npx electron-builder --mac --arm64 --dir --publish never
npm run test:architecture
node scripts/smoke-ui.cjs --packaged
node scripts/smoke-language.cjs
node scripts/smoke-script-editor.cjs --packaged
node scripts/smoke-macos-lifecycle.cjs
npx electron-builder --mac dmg zip --arm64 --prepackaged "release/mac-arm64/mitm gui.app" --publish never
```

On Intel use `--x64` and `release/mac`. `npm run package:mac` builds DMG/ZIP for the host architecture directly. Architecture checks inspect Mach-O headers with `lipo`, including native Python extensions, rather than trusting filenames. Smoke tests use isolated profiles. The lifecycle test checks the native Quit role and invokes `app.quit()`: CDP key injection does not invoke AppKit's Cmd+Q accelerator. Physical Dock clicking and native keyboard events still merit manual release QA.

CI uses `macos-15` (arm64) and `macos-15-intel` (x64), with matching Python/Node. It runs source tests, frozen-engine integration tests and packaged GUI checks before creating DMG/ZIP/checksums. Existing Windows x64/ARM64 jobs remain. A tagged release waits for **both operating systems and all architectures**. No workflow was dispatched and no release was published as part of the local port.

## Developer ID signing and notarization

Unsigned/ad-hoc builds work without secrets. For a trusted release configure repository Actions secrets:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application certificate exported as `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Password for that export |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Developer team identifier |

Set repository Actions variable **`MITM_GUI_NOTARIZE=true`** to require notarization. CI maps `MAC_CSC_LINK`/`MAC_CSC_KEY_PASSWORD` to electron-builder's `CSC_LINK`/`CSC_KEY_PASSWORD`. For local signed builds supply those electron-builder environment names directly plus the Apple values. Never commit them or paste them into build logs. Use protected release environments if your repository allows untrusted branch workflows; fork PRs receive no secrets.

With credentials, electron-builder signs the app and nested code using hardened runtime and the JIT entitlement. The after-sign hook calls `@electron/notarize` (notarytool), waits for acceptance and staples the app before distribution. Notarization is disabled unless explicitly requested; a request without credentials fails. The current local artifacts have **not** tested Developer ID signing, notarization or Gatekeeper acceptance. Validate a credentialed release using `codesign --verify --deep --strict`, `xcrun stapler validate` and `spctl --assess --type execute --verbose` on the final installed app, including the frozen engine and script workers.
