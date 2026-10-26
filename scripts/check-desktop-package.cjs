if (process.platform !== "darwin") {
  require("./check-windows-package.cjs");
} else {
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { arch, bundle, executable } = require("./desktop-build.cjs");
  const { requireArchitecture } = require("./macos-architecture.cjs");
  const engine = path.join(
    bundle,
    "Contents/Resources/backend/mitm-gui-engine",
  );
  fs.accessSync(engine, fs.constants.X_OK);
  requireArchitecture(executable, arch);
  requireArchitecture(engine, arch);
  // Check native Python extensions/libraries as well as the entry executable.
  let binaries = 0;
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.isFile()) {
        const type = execFileSync("/usr/bin/file", ["-b", file], {
          encoding: "utf8",
        });
        if (type.includes("Mach-O")) {
          requireArchitecture(file, arch);
          binaries++;
        }
      }
    }
  }
  inspect(path.join(bundle, "Contents/Resources/backend"));
  console.log(
    JSON.stringify({
      frontend: arch,
      engine: arch,
      nativeBinaries: binaries,
      bundle,
    }),
  );
}
