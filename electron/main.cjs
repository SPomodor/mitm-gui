const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
} = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const WebSocket = require("ws");

let window,
  backend,
  socket,
  api,
  secret,
  backendReady,
  quitting = false;
const root = path.join(__dirname, "..");
const editors = new Map();
if (process.env.CHLS_USER_DATA) {
  fs.mkdirSync(process.env.CHLS_USER_DATA, { recursive: true });
  app.setPath("userData", path.resolve(process.env.CHLS_USER_DATA));
}
const allowed =
  /^\/(status|mocks(?:\/(?:validate|control))?|capture\/(start|stop)|wireguard|certificate|rules(?:\/[a-zA-Z0-9-]+)?|sessions(?:\/[a-zA-Z0-9-]+(?:\/export)?)?|flows(?:\/[a-zA-Z0-9-]+(?:\/body\/(?:original_)?(?:request|response))?)?)(?:\?.*)?$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        process.platform === "win32" ? "chls-engine.exe" : "chls-engine",
      )
    : python;
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
      `Движок завершился (${code}). Лог: ${path.join(dataPath, "engine.log")}`,
    );
    if (!quitting)
      window?.webContents.send("backend:events", [
        { type: "fatal", message: failure.message },
      ]);
  });
  for (let i = 0; i < 150; i++) {
    if (failure) throw failure;
    try {
      await request("/status");
      connectEvents();
      return;
    } catch {}
    await sleep(200);
  }
  throw new Error(
    `Движок не запустился. Лог: ${path.join(dataPath, "engine.log")}`,
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
    title: "Правило — CHLS",
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
    title: "Файл для Map Local",
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("choose-mock-folder", async (event) => {
  const owner = trusted(event);
  const result = await dialog.showOpenDialog(owner, {
    title: "Папка с JSON для моков",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("mock-order-template", async (event) => {
  trusted(event);
  const base = app.isPackaged ? process.resourcesPath : root;
  return fs.promises.readFile(
    path.join(base, "examples", "order-187", "scenario.chls"),
    "utf8",
  );
});
ipcMain.handle("import-mock-script", async (event) => {
  const owner = trusted(event);
  const result = await dialog.showOpenDialog(owner, {
    title: "Открыть сценарий",
    properties: ["openFile"],
    filters: [{ name: "CHLS сценарий", extensions: ["chls", "txt"] }],
  });
  if (result.canceled) return null;
  if ((await fs.promises.stat(result.filePaths[0])).size > 800000)
    throw new Error("Сценарий слишком большой");
  return {
    source: await fs.promises.readFile(result.filePaths[0], "utf8"),
    folder: path.dirname(result.filePaths[0]),
  };
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
ipcMain.handle("export-session", async (event, id, name) => {
  trusted(event);
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(id) ||
    typeof name !== "string"
  )
    throw new Error("Invalid session");
  const filename =
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 120) || "session";
  const result = await dialog.showSaveDialog(window, {
    title: "Экспортировать сессию",
    defaultPath: filename + ".har",
    filters: [{ name: "HTTP Archive (HAR)", extensions: ["har"] }],
  });
  if (result.canceled || !result.filePath) return false;
  await backendReady;
  const temporary =
    result.filePath + "." + randomBytes(8).toString("hex") + ".partial";
  try {
    const response = await request(
      `/sessions/${id}/export`,
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
  if (stat.size > 2_000_000) throw new Error("Файл слишком большой");
  return JSON.parse(await fs.promises.readFile(result.filePaths[0], "utf8"));
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "CHLS",
        submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
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
          { role: "reload" },
          { role: "toggleDevTools" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    title: "CHLS",
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
  window.on("close", () => {
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
    dialog.showErrorBox("CHLS: движок недоступен", error.message);
  }
  app.on("activate", () => window?.show());
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  socket?.close();
  const finish = () => {
    backend?.kill();
    app.quit();
  };
  if (!backend || backend.exitCode !== null) return finish();
  request("/capture/stop", "POST")
    .catch(() => {})
    .finally(finish);
  setTimeout(finish, 2500).unref();
});
