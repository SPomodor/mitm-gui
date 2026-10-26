const { execFileSync } = require("node:child_process");
function requireArchitecture(file, expected) {
  const architectures = execFileSync("/usr/bin/lipo", ["-archs", file], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/);
  const native = expected === "x64" ? "x86_64" : expected;
  if (architectures.length !== 1 || architectures[0] !== native)
    throw new Error(
      `${file}: expected native ${native}, found ${architectures.join(" ")}`,
    );
  return architectures[0];
}
module.exports = { requireArchitecture };
