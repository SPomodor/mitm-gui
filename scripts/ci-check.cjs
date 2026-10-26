const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const child = spawn(process.execPath, args, {
  stdio: ["inherit", "pipe", "pipe"],
});
let tail = "";
function output(stream, chunk) {
  stream.write(chunk);
  tail = (tail + chunk.toString()).slice(-3500);
}
child.stdout.on("data", (chunk) => output(process.stdout, chunk));
child.stderr.on("data", (chunk) => output(process.stderr, chunk));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (code !== 0 && process.env.GITHUB_ACTIONS) {
    const message = tail
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(`::error title=Desktop smoke test::${message}`);
  }
  process.exitCode = code || (code === 0 ? 0 : 1);
});
