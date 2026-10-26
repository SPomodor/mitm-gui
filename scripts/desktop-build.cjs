const path = require("node:path");
if (process.platform !== "darwin") {
  module.exports = require("./windows-build.cjs");
} else {
  const arch = process.env.MITM_GUI_TARGET_ARCH || process.arch;
  if (!["arm64", "x64"].includes(arch))
    throw new Error(`Unsupported macOS architecture: ${arch}`);
  const unpackedDirectory = path.resolve(
    process.env.CHLS_SMOKE_BUILD_DIR || "release",
    arch === "arm64" ? "mac-arm64" : "mac",
  );
  const bundle = path.join(unpackedDirectory, "mitm gui.app");
  module.exports = {
    arch,
    unpackedDirectory,
    bundle,
    executable: path.join(bundle, "Contents/MacOS/mitm gui"),
  };
}
