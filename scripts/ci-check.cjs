const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const command =
  args[0] === "--command" ? (args.shift(), args.shift()) : process.execPath;
const timeout = Number(process.env.MITM_GUI_CI_TIMEOUT_MS || 0);
if (!Number.isFinite(timeout) || timeout < 0)
  throw new Error("Invalid CI timeout");
const grouped = timeout > 0 && process.platform !== "win32";
const child = spawn(command, args, {
  detached: grouped,
  stdio: ["inherit", "pipe", "pipe"],
});
let tail = "";
let timedOut = false;
let forceTimer;
const timer =
  timeout > 0
    ? setTimeout(() => {
        timedOut = true;
        const diagnostic = tail
          .replaceAll("%", "%25")
          .replaceAll("\r", "%0D")
          .replaceAll("\n", "%0A");
        console.log(`::error title=CI timeout::${diagnostic}`);
        output(
          process.stderr,
          Buffer.from(`\nCI command exceeded ${timeout}ms\n`),
        );
        const kill = (signal) => {
          try {
            if (grouped) process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        };
        kill("SIGTERM");
        forceTimer = setTimeout(() => kill("SIGKILL"), 5000);
      }, timeout)
    : undefined;
function output(stream, chunk) {
  stream.write(chunk);
  tail = (tail + chunk.toString()).slice(-12000);
}
child.stdout.on("data", (chunk) => output(process.stdout, chunk));
child.stderr.on("data", (chunk) => output(process.stderr, chunk));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  clearTimeout(timer);
  clearTimeout(forceTimer);
  if (code !== 0 && process.env.GITHUB_ACTIONS) {
    const message = tail
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(`::error title=CI check::${message}`);
  }
  process.exitCode = timedOut ? 124 : code || (code === 0 ? 0 : 1);
});
