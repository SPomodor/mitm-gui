# Application guide

[README](../README.md) · [Русский](application.ru.md) · [Python scripting](../SCRIPTS.md)

**mitm gui 0.9 — by SPomodor**

## Install and launch

Download the Windows x64 portable EXE from [Releases](https://github.com/SPomodor/mitm-gui/releases), or the `mitm-gui-windows-x64` artifact from a successful [Actions run](https://github.com/SPomodor/mitm-gui/actions/workflows/build.yml). The app includes its Python engine. You do not need Node.js, Python, a separate mitmproxy installation or an installed WireGuard server.

Run `mitm-gui-<version>-win-x64.exe`. The unsigned executable may trigger a Windows publisher warning. Extracted builds require the complete `win-unpacked` directory, not just `mitm gui.exe`.

At startup the app creates a new traffic session, enables recording and attempts to start the saved listeners. Existing sessions are archived. Applied scripts load disabled, with their initial managed state. If a port is occupied, open Connect device and change it.

## Workspace

- **Traffic:** captured requests/connections, host filters and the inspector.
- **Rules:** ordered Rewrite, Map Local and Blocklist rules.
- **Scripts:** a saved script library, Python editor, state controls and activity log.
- **Connect device:** HTTP/WireGuard settings and certificate instructions.
- **Sessions / Archive:** current recording session and previous captures.
- **Capture:** listener start/stop at the bottom of the sidebar.
- **Recording:** history recording toggle in the top toolbar.
- **SSL shield:** decryption toggle; its adjacent control opens host selection.

Drag a separator to resize the sidebar, traffic/inspector split, script editor/log split or session/host sections. Sizes persist. Double-click resets a separator. Keyboard controls: focus it with Tab, use arrows, Shift+arrows for larger steps, Home/End for bounds and Enter to reset.

Language is at the bottom left, next to appearance. **Auto** uses Russian for a Russian OS language and English otherwise. A manual choice is saved and updates all open rule windows without restarting. It does not translate traffic, user names or source code. Light, dark and system themes are supported.

## Recording versus capture

**Recording** controls whether new requests are saved in history. Pausing it does not stop the proxy, WireGuard, Rewrite or scripts. Requests already being recorded keep their responses; requests started while paused do not appear later when recording resumes.

**Capture** controls the actual HTTP/WireGuard listeners and their connections. Stopping it interrupts proxy connectivity. It is not equivalent to pausing history. Starting the app again retries the saved listeners even if you previously stopped capture manually.

## Connect a browser or phone over HTTP

1. Open **Connect device**, select **HTTP proxy** and enable its listener.
2. The default TCP port is `8080`; choose a free port if necessary.
3. For a phone, enable **Allow local network access** and use a computer address reachable from the phone.
4. In the client's proxy settings, enter that address and TCP port.
5. Open an HTTP URL through the proxy, then install the certificate for HTTPS.

Example on the same computer:

```sh
curl --proxy http://127.0.0.1:8080 http://example.com/
```

On Windows PowerShell, use `curl.exe` explicitly. The app does not configure your computer's system proxy automatically.

For Android: Wi-Fi/Internet → current network → Edit → Advanced options → Proxy → Manual. Manufacturer labels vary.

For iPhone: Settings → Wi-Fi → information button beside the network → Configure Proxy → Manual. Enter Server and Port; leave authentication off.

The phone and computer must be able to reach each other. Guest Wi-Fi, client isolation, another VPN or a firewall can block the connection. Allow the selected TCP port in the firewall when using LAN access.

## Connect with WireGuard

1. Enable WireGuard in Connect device; start capture.
2. Set the endpoint to a computer address reachable by the phone. The default port is `51820/udp`.
3. Install a WireGuard client on the phone.
4. Add a tunnel by scanning the app's QR code, or export the `.conf` file and import it.
5. Enable the tunnel and check traffic in the app.

The profile is intended for **one device at a time**. Do not share it publicly: it contains a private key. Allow the selected UDP port through the firewall. A local HTTP proxy need not be enabled when using WireGuard alone.

The generated tunnel routes IPv4. IPv6 capture is limited and IPv6 traffic may bypass it. Another VPN may conflict. The app does not intercept all traffic of the host computer through its own WireGuard endpoint.

## Certificates and HTTPS

Open `mitm.it` on the device while connected through the proxy or WireGuard. Install the certificate for that device. The app also offers **Save CA**.

On Android, install it as a user CA certificate in the security settings. Your own debug app may need a Network Security Config that trusts user CAs. Certificate pinning needs a separate debug configuration.

On iPhone, install the downloaded profile in Settings → General → VPN & Device Management, then enable full trust in General → About → Certificate Trust Settings.

The application does not silently install a trusted root certificate on the computer or device. Trust only the CA generated by your own instance. Remove it when no longer needed.

## Selective SSL decryption

The shield controls decryption for **new connections**. Settings offers:

- **All hosts:** decrypt supported TLS traffic when enabled.
- **Selected only:** decrypt only the listed destinations.

Enter one domain/IP per line, with an optional port. `*.example.com` matches subdomains; add `example.com` separately for the root domain. An empty selection decrypts nothing. Switching the master toggle off preserves the configured list.

You can add a host from a traffic row's context menu. Reconnect the client after changing scope: existing connections retain their original mode. A URL path cannot be selected before decryption because the path is encrypted.

Disabling decryption forwards TLS with the upstream certificate. HTTPS Rewrite and scripts cannot inspect its HTTP messages. Plain HTTP continues to work.

## Encrypted connection records

When SSL is disabled or a host is excluded, the app can still store a connection summary: destination/SNI or IP, port, protocol, open/close time, state, sent/received byte counts and errors.

A lock icon identifies encrypted records. Their inspector contains connection details, not HTTP headers, methods, URL paths or bodies. One connection can carry many encrypted HTTP requests; those requests cannot be reconstructed from the summary.

TCP/TLS summaries are supported; UDP/DTLS/QUIC observation is experimental. Recording, archive, clear and deletion also apply to these records.

## Traffic and inspector

Search by URL, method, status or client address. Filters include all, modified and errors. Host focus filters what you see without dropping capture: add hosts with the adjacent button or a row's context menu, then select Focused.

Select a row to inspect request and response headers, body and applied rules. Switch between the original and resulting message. Pretty formats JSON previews. Body search works across the whole available preview, including content outside the visible viewport; Enter/Shift+Enter navigates matches and Escape closes it.

The body preview is limited to **256 KB**. Download saves all available original body bytes. Buffered bodies up to **8 MB** can be modified; larger streamed bodies are marked unavailable for body Rewrite. The traffic list displays at most the latest **10,000** records, while export includes the full stored session.

## Rules

New rules can be created from the Rules page or an HTTP row's context menu. Conditions use the original request location captured before script/rule mutations.

- Host: exact domain/IP or a wildcard; empty matches any host.
- Method: a specific method or any.
- Path and query: matched separately with Exact, Contains or Regex.
- Paste a full URL into Path to split it into host, path and query.
- An empty path in Contains mode matches any path.

Rules run from top to bottom. You can enable, duplicate, reorder, import and export them. Each rule opens in a separate window, preserving other windows' drafts. Ctrl/Cmd+S saves; Escape cancels; Go to requests focuses the main window.

### Rewrite

Choose request, response or both phases. Actions include adding/modifying/removing headers and query parameters, changing Host/Path/URL, response status, body text and JSON fields.

Search supports case sensitivity, whole-value matching, Python regular expressions, and first/all replacement. Replacement groups use `$1`, `${name}` and `$$` for a literal dollar sign. HTTP headers are matched without case sensitivity.

A short JSON key such as `time` searches the entire body, including objects in arrays. It must be unique. Use `order.start.time`, an array index path or JSON Pointer `/order/start/time` when ambiguous. Ambiguity reports exact matching paths rather than modifying an arbitrary field.

Host changes the destination and Host/:authority. Path preserves query parameters. URL requires a complete `http://` or `https://` URL. Status must be 100–599. Content framing is adjusted for body changes and HEAD/204/304 behavior.

### Map Local

Select a local file, content type and status. The file is read on each request; it must be accessible and no larger than 8 MB. A matching local response stops ordinary request rule processing.

### Blocklist

Return a configured HTTP status or disconnect without a response. A matching block ends request processing.

The inspector lists rule results, no-match notes and errors. Invalid replacements keep the previous message rather than partially committing an invalid change.

## Python scripts and library

See the [complete scripting guide](../SCRIPTS.md).

The library stores each script's display name, code and JSON folder. Save/Ctrl+S writes text without executing it. Apply validates/compiles, saves and installs a revision, resetting its managed state; enabling is separate. Selecting or deleting another library item does not alter the running script.

Create, duplicate, rename, search, import `.py`/legacy `.chls`, or export `.py`. Export does not bundle JSON fixtures. Switching with unsaved changes offers save, discard or cancel. Closing warns about unsaved edits.

The editor provides Python syntax highlighting, line numbers, four-space Tab/Shift+Tab indentation, autoindent, undo/redo and Ctrl/Cmd+F search. Ctrl+M switches Tab to focus navigation. The activity log shows matching handlers, errors, state changes, transitions and user logs.

## Sessions, archive and export

Each launch creates a session. Creating another session archives the previous one; opening an archive does not redirect new recording. Rename/export sessions using their adjacent controls. Clear removes the selected session's traffic after confirmation; delayed responses cannot restore cleared records. The recording session cannot be deleted.

HAR export has two modes:

1. **Standard HAR:** stored HTTP requests/responses only.
2. **Charles connection summaries:** additionally creates synthetic CONNECT/CONNECT-UDP entries for encrypted connections. These represent addresses, timing and counters, not decrypted requests.

HAR includes project extensions for original messages and rule diagnostics. Legacy `_chls` extension names are retained for compatibility. Export is a snapshot independent of active filters. HAR session import is not implemented.

## Storage and migration

The profile location is Electron's `app.getPath('userData')`; on Windows a new installation normally uses `%APPDATA%/mitm gui`. Existing CHLS profiles are reused automatically when detected.

- `engine/`: database, body files, CA, WireGuard keys, capture settings and applied script.
- `script-library.json`: saved scripts, fixture folder paths and selection.
- `language.json`: Auto/Russian/English preference.
- Electron local storage: theme, layout and host focus.

History, rules, library and capture preferences persist. Recording starts enabled; scripts start disabled with initial state. Unsaved editor changes are not a saved script. Python module globals are not persisted by managed-state reset.

Back up the profile only while the app is closed. It may contain credentials, private keys and response bodies. Do not publish it.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+K | Traffic search |
| Ctrl/Cmd+F | Body search, or script search when editing code |
| Enter / Shift+Enter | Next / previous search match |
| Ctrl/Cmd+S | Save rule or script library item |
| Ctrl+Shift+R | Start/stop capture |
| Escape | Close search, dialog or rule editor |
| Arrow keys | Navigate requests or resize a focused separator |
| Tab / Shift+Tab | Indent/unindent script selection |
| Ctrl+M then Tab | Leave the code editor with the keyboard |

## Troubleshooting

**No requests:** check listener status, address/port, LAN access, firewall, Wi-Fi isolation and the client proxy/tunnel. Opening an archived session can hide new live records.

**HTTPS fails:** verify CA installation and trust, SSL scope, and the app's debug pinning configuration. Reconnect after changing SSL settings.

**Only a lock/connection appears:** the flow was not decrypted. The path cannot be recovered from encrypted bytes.

**A rule does not match:** check method, host, original location, path/query separation and phase. Inspect rule diagnostics.

**A script does not replace a response:** apply and enable the intended revision, check its hosts/prefix and exact route, current stage and activity log. A handler returning None forwards to the server.

**Missing fixtures:** choose the directory relative to which `file=` and `load_json()` paths resolve, then apply again. Fixtures are snapshotted at compile time.

**Engine fails to launch:** check `engine/engine.log` in the profile and port conflicts. Share a redacted log, not the entire profile.

## Windows ARM64 (hybrid)

Version 0.9.1 adds a native ARM64 interface with the x64 engine running under Windows 11 emulation. It is not a fully native ARM64 build. Windows x86/32-bit, ARM32 and Windows 10 ARM are not supported. Choose the correct architecture in Releases.

## macOS

See the [macOS guide](macos.md) for DMG/ZIP installation, Gatekeeper, manual HTTP/HTTPS proxy setup/restoration, explicit Keychain CA trust, WireGuard and the profile under `~/Library/Application Support/mitm-gui`. Apple Silicon/macOS 15.8.1 is locally verified; see the [validation record](macos-validation.md) for Intel and other versions. Closing the window hides it; Cmd+Q quits capture. Use Cmd+K/F/S for search and save.
