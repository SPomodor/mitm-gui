const path = require("node:path");
const { version } = require("../package.json");
const arch = process.env.MITM_GUI_TARGET_ARCH || process.arch;
if (!["x64", "arm64"].includes(arch)) {
  throw new Error(`Windows ${arch} is unsupported. Use x64 or ARM64 (hybrid).`);
}
const directory = process.env.CHLS_SMOKE_BUILD_DIR || "release";
const unpackedDirectory = path.join(
  directory,
  arch === "x64" ? "win-unpacked" : "win-arm64-unpacked",
);
module.exports = {
  arch,
  unpackedDirectory,
  executable: path.resolve(unpackedDirectory, "mitm gui.exe"),
  portable: path.resolve(directory, `mitm-gui-${version}-win-${arch}.exe`),
};
