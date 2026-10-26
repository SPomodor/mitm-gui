const path = require("node:path");
const { execFileSync } = require("node:child_process");
module.exports = async (context) => {
  if (context.electronPlatformName !== "darwin" || process.env.CSC_LINK) return;
  // Renaming Electron invalidates its original seal. Ad-hoc signing repairs
  // local integrity on Apple Silicon; it provides no publisher identity/trust.
  const bundle = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", bundle],
    { stdio: "inherit" },
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", bundle],
    { stdio: "inherit" },
  );
};
