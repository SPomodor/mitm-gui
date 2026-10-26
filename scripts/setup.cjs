const fs = require("node:fs");
const { python, run } = require("./python.cjs");
if (!fs.existsSync(python))
  run(
    process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-m", "venv", ".venv"],
  );
run(python, ["-m", "pip", "install", "-r", "requirements-dev.txt"]);
run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
  shell: process.platform === "win32",
});
console.log("Ready. Run npm run dev.");
