const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
  clipboard,
} = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const WebSocket = require("ws");
const { ScriptLibrary } = require("./script-library.cjs");
const translations = require("./locales/en.json");

let window,
  backend,
  socket,
  api,
  secret,
  backendReady,
  quitting = false,
  quitRequested = false;
const root = path.join(__dirname, "..");
const editors = new Map();
if (process.env.CHLS_USER_DATA) {
  fs.mkdirSync(process.env.CHLS_USER_DATA, { recursive: true });
  app.setPath("userData", path.resolve(process.env.CHLS_USER_DATA));
} else {
  // Reuse an existing profile when upgrading from the former CHLS name.
  for (const name of ["CHLS", "chls"]) {
    const legacy = path.join(app.getPath("appData"), name);
    if (fs.existsSync(path.join(legacy, "engine"))) {
      app.setPath("userData", legacy);
      break;
    }
  }
}
const allowed =
  /^\/(status|recording|mocks(?:\/(?:validate|control|convert))?|capture\/(start|stop|ssl)|wireguard|certificate|rules(?:\/[a-zA-Z0-9-]+)?|sessions(?:\/[a-zA-Z0-9-]+(?:\/export)?)?|flows(?:\/[a-zA-Z0-9-]+(?:\/body\/(?:original_)?(?:request|response)(?:\/text)?)?)?)(?:\?.*)?$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let languagePreference;
function language() {
  if (!languagePreference) {
    try {
      languagePreference = JSON.parse(
        fs.readFileSync(
          path.join(app.getPath("userData"), "language.json"),
          "utf8",
        ),
      ).preference;
    } catch {}
    if (!["auto", "ru", "en"].includes(languagePreference))
      languagePreference = "auto";
  }
  return {
    preference: languagePreference,
    systemLocale: process.env.CHLS_SYSTEM_LOCALE || app.getLocale(),
  };
}
function nativeT(source, values = []) {
  const { preference, systemLocale } = language();
  const russian =
    preference === "ru" ||
    (preference === "auto" && /^ru(?:-|_|$)/i.test(systemLocale));
  return (russian ? source : (translations[source] ?? source)).replace(
    /\{(\d+)\}/g,
    (match, index) => (index < values.length ? String(values[index]) : match),
  );
}
ipcMain.on("get-language", (event) => {
  event.returnValue = language();
});
ipcMain.handle("set-language", (event, preference) => {
  trusted(event);
  if (!["auto", "ru", "en"].includes(preference))
    throw new Error("Invalid language");
  const file = path.join(app.getPath("userData"), "language.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify({ preference }), {
    mode: 0o600,
  });
  fs.renameSync(file + ".tmp", file);
  languagePreference = preference;
  for (const target of BrowserWindow.getAllWindows())
    target.webContents.send("language-changed", preference);
});

async function request(route, method = "GET", data, timeout = 20000) {
  if (
    !allowed.test(route) ||
    !["GET", "POST", "PUT", "DELETE"].includes(method)
  )
    throw new Error("Unsupported request");
  const response = await fetch(api + route, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {
      error = { detail: response.statusText };
    }
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : JSON.stringify(error.detail),
    );
  }
  return response;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function connectEvents() {
  if (quitting) return;
  socket = new WebSocket(api.replace("http:", "ws:") + "/events", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  socket.on("message", (data) => {
    try {
      const events = JSON.parse(data.toString());
      for (const target of [
        window,
        ...[...editors.values()].map((item) => item.window),
      ])
        if (target && !target.isDestroyed())
          target.webContents.send("backend:events", events);
    } catch {}
  });
  socket.on("error", () => {});
  socket.on("open", () =>
    window?.webContents.send("backend:events", [{ type: "resync" }]),
  );
  socket.on("close", () => {
    if (!quitting) setTimeout(connectEvents, 1500);
  });
}

async function startBackend() {
  secret = randomBytes(32).toString("hex");
  const port = await freePort();
  api = `http://127.0.0.1:${port}`;
  const python =
    process.platform === "win32"
      ? path.join(root, ".venv", "Scripts", "python.exe")
      : path.join(root, ".venv", "bin", "python");
  const exe = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "backend",
        process.platform === "win32"
          ? "mitm-gui-engine.exe"
          : "mitm-gui-engine",
      )
    : python;
  if (app.isPackaged && process.platform !== "win32")
    fs.accessSync(exe, fs.constants.X_OK);
  const args = app.isPackaged
    ? ["--port", String(port)]
    : ["-m", "backend", "--port", String(port)];
  const dataPath = path.join(app.getPath("userData"), "engine");
  fs.mkdirSync(dataPath, { recursive: true });
  const log = fs.createWriteStream(path.join(dataPath, "engine.log"), {
    flags: "w",
  });
  backend = spawn(exe, args, {
    cwd: app.isPackaged ? process.resourcesPath : root,
    windowsHide: true,
    env: {
      ...process.env,
      CHLS_TOKEN: secret,
      CHLS_DATA: dataPath,
      CHLS_VERSION: app.getVersion(),
      PYTHONUTF8: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  backend.stdout.pipe(log);
  backend.stderr.pipe(log);
  let failure;
  backend.on("error", (error) => {
    failure = error;
  });
  backend.on("exit", (code) => {
    failure = new Error(
      nativeT("Движок завершился ({0}). Лог: {1}", [
        code,
        path.join(dataPath, "engine.log"),
      ]),
    );
    if (!quitting)
      window?.webContents.send("backend:events", [
        { type: "fatal", message: failure.message },
      ]);
  });
  for (let i = 0; i < 150; i++) {
    if (quitting) return;
    if (failure) throw failure;
    try {
      await request("/status");
      connectEvents();
      return;
    } catch {}
    await sleep(200);
  }
  throw new Error(
    nativeT("Движок не запустился. Лог: {0}", [
      path.join(dataPath, "engine.log"),
    ]),
  );
}

function trusted(event) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (
    !owner ||
    (owner !== window &&
      ![...editors.values()].some((item) => item.window === owner)) ||
    event.senderFrame !== owner.webContents.mainFrame
  )
    throw new Error("Untrusted sender");
  return owner;
}

function configureWindow(target) {
  target.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(target, {
      type: "question",
      title: nativeT("Несохранённый сценарий"),
      message: nativeT("В сценарии есть несохранённые изменения."),
      detail: nativeT(
        "Вернитесь в редактор и нажмите Ctrl+S, чтобы сохранить их в библиотеке.",
      ),
      buttons: [nativeT("Вернуться"), nativeT("Закрыть без сохранения")],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
    else quitRequested = false;
  });
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  target.webContents.on("will-navigate", (event) => event.preventDefault());
  target.webContents.on("context-menu", (_, params) => {
    const template = params.isEditable
      ? [
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ]
      : [
          { role: "copy", enabled: !!params.selectionText },
          { role: "selectAll" },
        ];
    Menu.buildFromTemplate(template).popup({ window: target });
  });
}

ipcMain.handle("open-rule-editor", async (event, rule) => {
  if (trusted(event) !== window) throw new Error("Unsupported sender");
  if (
    !rule ||
    typeof rule !== "object" ||
    typeof rule.id !== "string" ||
    !rule.id.length ||
    rule.id.length > 100 ||
    JSON.stringify(rule).length > 2_000_000
  )
    throw new Error("Invalid rule");
  const existing = editors.get(rule.id);
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) existing.window.restore();
    existing.window.show();
    existing.window.focus();
    return;
  }
  const editor = new BrowserWindow({
    width: 660,
    height: 840,
    minWidth: 520,
    minHeight: 480,
    title: nativeT("Правило — mitm gui"),
    backgroundColor: "#151618",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  editors.set(rule.id, { window: editor, rule });
  editor.on("closed", () => editors.delete(rule.id));
  configureWindow(editor);
  try {
    if (app.isPackaged)
      await editor.loadFile(path.join(root, "dist", "index.html"), {
        hash: "rule-editor",
      });
    else await editor.loadURL("http://127.0.0.1:5173/#rule-editor");
    editor.show();
    editor.focus();
  } catch (error) {
    editor.destroy();
    throw error;
  }
});
ipcMain.handle("rule-editor-data", (event) => {
  const owner = trusted(event);
  const item = [...editors.values()].find((item) => item.window === owner);
  if (!item) throw new Error("Not a rule editor");
  return item.rule;
});
ipcMain.handle("close-rule-editor", (event) => {
  const owner = trusted(event);
  if (owner !== window) owner.close();
});
ipcMain.handle("focus-main", (event) => {
  trusted(event);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

ipcMain.handle("api", async (event, route, method, data) => {
  trusted(event);
  await backendReady;
  return (await request(route, method, data)).json();
});
ipcMain.handle("choose-file", async (event) => {
  const owner = trusted(event);
  const result = await dialog.showOpenDialog(owner, {
    properties: ["openFile"],
    title: nativeT("Файл для Map Local"),
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("choose-mock-folder", async (event) => {
  const owner = trusted(event);
  const result = await dialog.showOpenDialog(owner, {
    title: nativeT("Папка с JSON для моков"),
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});
for (const action of ["read", "save", "select", "remove"]) {
  ipcMain.handle(`script-library-${action}`, (event, value) => {
    trusted(event);
    const library = new ScriptLibrary(
      path.join(app.getPath("userData"), "script-library.json"),
    );
    return library[action](value);
  });
}
ipcMain.handle("import-mock-script", async (event) => {
  const owner = trusted(event);
  const result = await dialog.showOpenDialog(owner, {
    title: nativeT("Открыть сценарий"),
    properties: ["openFile"],
    filters: [
      { name: "Python / legacy CHLS", extensions: ["py", "chls", "txt"] },
    ],
  });
  if (result.canceled) return null;
  if ((await fs.promises.stat(result.filePaths[0])).size > 800000)
    throw new Error(nativeT("Сценарий слишком большой"));
  return {
    name: path.basename(result.filePaths[0], path.extname(result.filePaths[0])),
    source: await fs.promises.readFile(result.filePaths[0], "utf8"),
    folder: path.dirname(result.filePaths[0]),
  };
});
ipcMain.handle("copy-text", (event, text) => {
  trusted(event);
  if (typeof text !== "string") throw new Error("Invalid clipboard text");
  return clipboard.writeText(text);
});
ipcMain.handle("save-text", async (event, name, text) => {
  trusted(event);
  if (typeof text !== "string" || text.length > 10_000_000)
    throw new Error("Invalid file");
  const result = await dialog.showSaveDialog(window, {
    defaultPath: path.basename(name),
  });
  if (!result.canceled) {
    await fs.promises.writeFile(result.filePath, text, { mode: 0o600 });
    return true;
  }
  return false;
});
ipcMain.handle("download", async (event, route, name) => {
  trusted(event);
  if (
    !/^\/(certificate|flows\/[a-zA-Z0-9-]+\/body\/(?:original_)?(?:request|response))$/.test(
      route,
    )
  )
    throw new Error("Invalid download");
  const result = await dialog.showSaveDialog(window, {
    defaultPath: path.basename(name),
  });
  if (result.canceled) return false;
  const response = await request(route);
  await fs.promises.writeFile(
    result.filePath,
    Buffer.from(await response.arrayBuffer()),
  );
  return true;
});
ipcMain.handle("export-session", async (event, id, name, format = "http") => {
  trusted(event);
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(id) ||
    typeof name !== "string" ||
    !["http", "charles"].includes(format)
  )
    throw new Error("Invalid session");
  const filename =
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 120) || "session";
  const result = await dialog.showSaveDialog(window, {
    title: nativeT("Экспортировать сессию"),
    defaultPath: filename + (format === "charles" ? "-charles.har" : ".har"),
    filters: [{ name: "HTTP Archive (HAR)", extensions: ["har"] }],
  });
  if (result.canceled || !result.filePath) return false;
  await backendReady;
  const temporary =
    result.filePath + "." + randomBytes(8).toString("hex") + ".partial";
  try {
    const response = await request(
      `/sessions/${id}/export?format=${format}`,
      "GET",
      undefined,
      300000,
    );
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await fs.promises.rename(temporary, result.filePath);
    return true;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
});
ipcMain.handle("import-rules", async (event) => {
  trusted(event);
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled) return null;
  const stat = await fs.promises.stat(result.filePaths[0]);
  if (stat.size > 2_000_000) throw new Error(nativeT("Файл слишком большой"));
  return JSON.parse(await fs.promises.readFile(result.filePaths[0], "utf8"));
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "mitm gui",
        submenu: [
          { role: "about" },
          ...(process.platform === "darwin"
            ? [
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
              ]
            : []),
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          ...(process.platform === "darwin" ? [] : [{ role: "reload" }]),
          { role: "toggleDevTools" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      ...(process.platform === "darwin" ? [{ role: "windowMenu" }] : []),
    ]),
  );
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: "mitm gui",
    backgroundColor: "#151618",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  configureWindow(window);
  window.on("close", (event) => {
    if (process.platform === "darwin" && !quitRequested) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    for (const item of editors.values()) item.window.destroy();
  });
  backendReady = startBackend();
  // Catch immediately while Vite or the renderer loads.
  backendReady.catch(() => {});
  if (app.isPackaged)
    await window.loadFile(path.join(root, "dist", "index.html"));
  else await window.loadURL("http://127.0.0.1:5173");
  try {
    await backendReady;
    window.webContents.send("backend:events", [{ type: "resync" }]);
  } catch (error) {
    // Closing during startup can terminate the backend before its readiness
    // promise settles. Do not show a startup failure for an app already closed.
    if (!quitting && window && !window.isDestroyed())
      dialog.showErrorBox(
        nativeT("mitm gui: движок недоступен"),
        error.message,
      );
  }
});
app.on("activate", () => {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || quitRequested) app.quit();
});
app.on("before-quit", (event) => {
  if (quitting) return;
  quitRequested = true;
  // Let the renderer resolve unsaved edits before shutting down its engine.
  if (window && !window.isDestroyed()) {
    event.preventDefault();
    window.close();
    return;
  }
  event.preventDefault();
  quitting = true;
  socket?.close();
  const child = backend;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (!child || child.exitCode !== null || child.signalCode !== null)
      return app.quit();
    child.once("exit", () => app.quit());
    child.kill();
    // Allow uvicorn/mitmproxy and script workers to finish shutdown before exit.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      app.quit();
    }, 3000).unref();
  };
  if (!child || child.exitCode !== null || child.signalCode !== null)
    return finish();
  request("/sessions/close", "POST", undefined, 1500)
    .then(() => request("/capture/stop", "POST", undefined, 1500))
    .catch(() => {})
    .finally(finish);
  setTimeout(finish, 2500).unref();
});
