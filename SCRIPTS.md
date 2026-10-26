# Python scripting guide

[README](README.md) · [Русский](docs/scripts.ru.md) · [Application guide](docs/application.md)

Scripts are regular Python executed in a separate process. The app provides the `mitm_gui` module in that process; a separate Python installation is not needed in the packaged app. The former `chls` import remains an alias for existing scripts.

## First script

Open Scripts, create a library item, paste the code, then **Validate → Apply script → Enable script**.

```python
from mitm_gui import Script, response

app = Script("Hello", hosts=["example.com"], path_prefix="/api/")

@app.get("/api/hello")
def hello(request, ctx):
    ctx.state["visits"] = ctx.state.get("visits", 0) + 1
    return response(200, json={"message": "Hello!", "visits": ctx.state["visits"]})
```

Request `http://example.com/api/hello` through the app's HTTP proxy. Other requests pass through. HTTPS needs CA trust and SSL decryption for the destination. The built-in Example contains a counter and a two-stage scenario without fixture files.

## Save, apply and run

Each library item stores a name, source and JSON folder. Save/Ctrl+S writes text without executing it, including unfinished code. Validate compiles a temporary revision without replacing the active one. Apply compiles, snapshots fixtures, installs a revision and resets managed state. Enable/disable controls execution separately.

Selection, rename, duplicate, import/export and deletion affect library entries. They do not implicitly replace the running revision. Exported `.py` files do not contain fixture JSON. Switching with unsaved changes offers save/discard/cancel. After restarting, the library and selected item are restored; the installed script is disabled.

The editor supports Tab/Shift+Tab indentation with four spaces, automatic indentation, undo/redo and Ctrl/Cmd+F search. Enter/Shift+Enter navigates matches; Escape closes search. Ctrl+M followed by Tab leaves the editor with the keyboard.

## Script scope

A top-level variable named `app` is required:

```python
app = Script(
    "My API",
    hosts=["api.example.com"],
    path_prefix="/api/",
    unmatched="forward",
)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | required | Nonempty name, up to 200 characters |
| `hosts` | all hosts | Up to 20 exact domains/IPs, or `["*"]` |
| `path_prefix` | `"/"` | Scope for requests and response handlers |
| `unmatched` | `"forward"` | Forward unhandled requests, or `"block"` to return 501 |

`hosts=None`, `[]` or `["*"]` means all hosts. Script hosts do not use the SSL host-list wildcard syntax. Prefix matching observes path-segment boundaries: `/api/` excludes `/api-other`.

You can assign `app.hosts`, `app.path_prefix` and `app.unmatched` after constructing the Script. Values are captured during validation/application. There are no separate GUI host/prefix settings.

In block mode, an unmatched request inside scope receives `CHLS_SCRIPT_UNHANDLED` (a legacy diagnostic code). A matching handler that explicitly returns None still forwards.

## Request handlers

```python
@app.get("/api/item")
def get_item(request, ctx):
    return response(200, json={"id": 1})

@app.post("/api/item")
def create_item(request, ctx):
    ctx.log(request.json.data)
    return response(201, json={"created": True})

@app.route("DELETE", "/api/item")
def delete_item(request, ctx):
    return response(204)
```

- `@app.get(path)`, `@app.post(path)` and `@app.route(method, path)` register request handlers.
- Methods and paths can use `"*"` for any method/path.
- `@app.on_request` registers a catch-all request handler within scope.
- Paths match exactly and exclude the query string. Inspect `request.query` separately.
- State-specific handlers take priority over shared handlers. Within each group, registration order applies.
- Only the first matching request handler runs. Returning None does **not** continue to another script handler.
- Handlers are synchronous `def` functions; async handlers are unsupported.

```python
@app.on_request
def annotate(request, ctx):
    request.headers["X-Debug"] = "mitm-gui"
    return None
```

A request handler can return `response(...)` for a local response, or `None` / `forward()` to send the modified request through normal rules to the upstream server.

## Response handlers

```python
@app.on_response
def adjust(request, reply, ctx):
    if request.path == "/api/item":
        reply.json.set("time", 123)
        reply.headers["X-Debug"] = "modified"
        ctx.log("Adjusted response time")
```

Response handlers receive `(request, reply, ctx)` and run in registration order. Modify the reply and return None, or return a new `response(...)`.

For upstream responses, normal response Rewrite rules run before script response handlers. Normal response Rewrite is skipped for script-local responses. Responses belonging to a previous revision do not run a newly applied revision. Disabling a script skips its pending response processing.

## Message API

| Request | Meaning |
| --- | --- |
| `method` | Mutable HTTP method |
| `url` | Mutable full HTTP/HTTPS URL |
| `path` | Read-only parsed URL path |
| `query` | Parsed dictionary of lists; editing this returned dictionary does not update the URL |
| `headers` | Case-insensitive mitmproxy Headers |
| `content` | Body bytes; assignment requires bytes/bytearray |
| `text` | UTF-8 text body |
| `json` | Mutable Json wrapper parsed from the body |
| `client` | Client address supplied by the capture engine |

For response messages, use `status`, `headers`, `content`, `text` and `json`. To change a path or query, assign a complete `request.url`. Changing text/content resets the parsed JSON cache. Invalid UTF-8/JSON raises an error; check content type or use bytes for binary data.

## Construct a response

```python
response(200, json={"ok": True})
response(200, file="reply.json")
response(200, text="Hello", headers={"X-Debug": "yes"})
response(204)
```

Choose only one of `json`, `file` or `text`. `file` loads a JSON fixture, not an arbitrary binary file. JSON content type is set automatically; text defaults to UTF-8 plain text. Status must be 200–599. 204/304 responses must be empty; HEAD sends headers without a body. The engine adjusts content framing after modifications.

## JSON helpers and short field names

```python
from mitm_gui import Json

body = Json({"order": {"start": {"time": 1}}})
body.get("time")                    # 1, because only one field is named time
body.set("time", 123)
body.set("order.start.time", 456)
body.set("/order/start/time", 789)
body.data["debug"] = True
body.remove("debug")
```

`Json.data` is a regular Python dictionary/list. `get`, `set` and `remove` share their selector behavior with Rewrite → JSON field.

| Selector | Behavior |
| --- | --- |
| `time` | Search the whole JSON for a unique field name, including objects in arrays |
| `order.start.time` | Exact path from the root |
| `items.0.time` | Exact path through an array index |
| `/order/start/time` | JSON Pointer; `~1` escapes `/` and `~0` escapes `~` |
| `/literal.key` | A literal key containing a dot |

A short name must match exactly once, even if one match is at the root. Ambiguity raises an error listing up to five exact paths. Missing names also raise errors. To add a new field, use an exact selector such as `/new_field`; its parent must already exist. Intermediate objects are not created automatically.

Values preserve JSON types, including numbers, False, None, objects and lists. Each fixture load returns a fresh copy.

## Fixture snapshots

Choose the directory containing your JSON files in the editor, then use paths relative to it:

```python
@app.get("/api/item")
def item(request, ctx):
    body = ctx.load_json("responses/item.json")
    body.set("time", 123)
    return response(200, json=body)
```

The compiler discovers literal filenames in `load_json(...)` and `response(file=...)`. For computed paths, declare every possible filename:

```python
app.files = ["responses/ready.json", "responses/done.json"]

@app.get("/api/item")
def item(request, ctx):
    name = "done" if ctx.state.get("done") else "ready"
    return response(200, file=f"responses/{name}.json")
```

Files must stay inside the selected folder. Each file is limited to 8 MB, and the unique snapshot to 64 MB. Files are loaded during validation/application; editing them afterward does not alter the running revision. Apply again to refresh the snapshot.

## Variables and sessions

`ctx.state` is a mutable dictionary. It is copied for each execution and committed with the resulting message after validation. It must remain JSON-serializable; Python objects/functions are not valid managed state.

By default, all traffic uses the shared `global` context. To split it by device or account:

```python
app.session_key = lambda request: request.headers.get("X-Device-Id", "default")
```

The key must be a nonempty string of up to 200 characters. The response phase uses the key captured for its request. Maximum: 1,000 contexts, 1 MB per returned state and 4 MB across managed contexts.

Reset clears managed contexts and returns stages to their initial values. It does not recreate Python module globals. Applying a new revision recreates the worker process.

## Scenarios

Scenario is optional state routing on top of the same Python handlers:

```python
from mitm_gui import Script, Scenario, response

app = Script("Checkout", hosts=["example.com"], path_prefix="/api/")
checkout = Scenario("checkout", initial="created")
app.use(checkout)

@checkout.post("/api/confirm", state="created")
def confirm(request, ctx):
    ctx.goto("confirmed")
    return response(201, json={"success": True})

@checkout.get("/api/order", state="confirmed")
def confirmed(request, ctx):
    return response(200, json={"status": ctx.stage})
```

Stages are declared by `initial` and handlers' `state` arguments. `ctx.goto(stage)` validates the destination. One Scenario is allowed per Script; use `ctx.state` for additional data. A stage and its variables belong to the selected session context.

Transitions and responses are explicit. There are no hidden success responses or automatic duplicate suppression. A repeated request runs the matching handler again.

## Stop from code

```python
@app.post("/api/complete")
def complete(request, ctx):
    ctx.state["done"] = True
    ctx.stop()
    return response(200, json={"done": True})
```

`ctx.stop()` disables the entire script after a successful handler. It sets a flag; Python continues until the handler returns. The current response is sent, subsequent requests use the regular route, and managed state is retained. Enable it with the UI button to continue; Reset starts managed state again.

If the handler fails, its state/message changes and stop request are rolled back. In response processing, stop also skips later response callbacks. It is not an early return and does not affect other scripts' library files.

## Diagnostics, limits and trust

The activity log shows handler names/lines, phase, stage transitions, state changes, errors and `ctx.log(value)`. Forwarded requests appear as “→ upstream”.

| Limit | Value |
| --- | --- |
| Script source | 200,000 characters |
| Initialization | 10 seconds |
| Handler execution | 2 seconds |
| Registered handlers | 1,000 |
| Buffered body / one fixture | 8 MB |
| Fixture snapshot | 64 MB |
| Managed contexts | 1,000 |
| Managed state | 1 MB per execution, 4 MB total |

A timed-out or crashed worker must be reapplied. Script errors are recorded; request errors may return a diagnostic 500. A failed response handler preserves the prior valid response. Managed state and messages are transactional, but arbitrary Python side effects cannot be rolled back.

**Scripts are trusted code, not a security sandbox.** They have filesystem and system access. Validation executes top-level code too. Keep long work outside handlers, use trusted scripts, and avoid logging tokens. Arbitrary third-party Python packages are not automatically included in the portable app.

## Legacy compatibility

Old `.chls` documents can be imported and converted to a reviewable Python draft. Inspect transition responses before applying: implicit success responses and repeat suppression from the old language are not recreated.

Saved single-script settings migrate into visible source assignments for hosts/prefix/unmatched policy. Old files are not overwritten until you apply. The engine's applied document remains `engine/script-module.json`; the library is stored separately in `script-library.json`.

`from chls import ...` and existing error codes remain compatible. Prefer `from mitm_gui import ...` in new code. The historical order-187 example remains in source for regression coverage and is not shipped as a built-in template.
