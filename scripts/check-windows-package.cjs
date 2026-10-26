const fs = require("node:fs");
const path = require("node:path");
const { arch, executable, unpackedDirectory } = require("./windows-build.cjs");
const machines = { 0x8664: "x64", 0xaa64: "arm64", 0x14c: "ia32" };
function peArchitecture(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.toString("ascii", 0, 2) !== "MZ")
    throw new Error(`${file}: not a PE executable`);
  const offset = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt32LE(offset) !== 0x4550)
    throw new Error(`${file}: invalid PE header`);
  return machines[bytes.readUInt16LE(offset + 4)] || "unknown";
}
const frontend = peArchitecture(executable);
const engine = peArchitecture(
  path.join(unpackedDirectory, "resources/backend/mitm-gui-engine.exe"),
);
if (frontend !== arch || engine !== "x64") {
  throw new Error(
    `Architecture mismatch: requested ${arch}, frontend ${frontend}, engine ${engine}`,
  );
}
console.log(
  JSON.stringify({
    frontend,
    engine,
    hybrid: frontend !== engine,
    requires:
      arch === "arm64" ? "Windows 11 ARM64 with x64 emulation" : "Windows x64",
  }),
);
