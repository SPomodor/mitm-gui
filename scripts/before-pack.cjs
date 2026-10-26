const path = require("node:path");
module.exports = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK) {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "true";
    context.packager.config.forceCodeSigning = true;
  } else {
    context.packager.platformSpecificBuildOptions.identity = null;
    if (process.env.MITM_GUI_NOTARIZE === "true")
      throw new Error("Notarization requires Developer ID credentials");
  }
  const arch = require("builder-util").Arch[context.arch];
  if (process.platform !== "darwin" || arch !== process.arch)
    throw new Error(
      "Build the macOS engine and app on a Mac of the target architecture; cross-packaging is disabled.",
    );
  require("./macos-architecture.cjs").requireArchitecture(
    path.join(
      context.packager.projectDir,
      "runtime/mitm-gui-engine/mitm-gui-engine",
    ),
    arch,
  );
};
