const fs = require("node:fs");
const { python, run } = require("./python.cjs");
if (!fs.existsSync(python))
  run(
    process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-m", "venv", ".venv"],
  );
if (process.platform === "win32") {
  run(python, [
    "-c",
    "import sysconfig; assert sysconfig.get_platform() == 'win-amd64', 'The Windows engine needs x64 Python 3.13, including on ARM64. Recreate .venv with an x64 Python executable (PYTHON environment variable).'",
  ]);
}
run(python, ["-m", "pip", "install", "-r", "requirements-dev.txt"]);
run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
  shell: process.platform === "win32",
});
console.log("Ready. Run npm run dev.");
