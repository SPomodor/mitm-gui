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
if (process.platform === "darwin")
  run(python, [
    "-c",
    `import sys, platform; assert sys.version_info[:2] == (3, 13), 'Use Python 3.13'; assert platform.machine() == '${process.arch === "x64" ? "x86_64" : "arm64"}', 'Use Python matching Node architecture'`,
  ]);
run(python, ["-m", "pip", "install", "-r", "requirements-dev.txt"]);
run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], {
  shell: process.platform === "win32",
});
console.log("Ready. Run npm run dev.");
