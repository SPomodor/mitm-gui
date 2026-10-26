const { spawnSync } = require("node:child_process");
const { requirePython, run, root } = require("./python.cjs");
const python = requirePython();
const modules = ["mitmproxy", "mitmproxy_rs", "uvicorn", "websockets"];
// Rust support wheels differ by OS. Never bundle a Windows module into a Mac build.
const native =
  process.platform === "win32"
    ? "mitmproxy_windows"
    : process.platform === "darwin"
      ? "mitmproxy_macos"
      : "mitmproxy_linux";
const probe = spawnSync(
  python,
  [
    "-c",
    `import importlib.util; print(bool(importlib.util.find_spec('${native}')))`,
  ],
  { cwd: root, encoding: "utf8" },
);
if (probe.status !== 0)
  throw new Error(probe.stderr || "Cannot inspect native dependencies");
if (probe.stdout.trim() === "True") modules.push(native);
run(python, [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--name",
  "mitm-gui-engine",
  "--onedir",
  "--distpath",
  "runtime",
  "--workpath",
  "build/engine",
  "--specpath",
  "build",
  "--paths",
  ".",
  ...modules.flatMap((name) => ["--collect-all", name]),
  "backend/entry.py",
]);
