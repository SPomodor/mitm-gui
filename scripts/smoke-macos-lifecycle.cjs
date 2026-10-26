delete process.env.ELECTRON_RUN_AS_NODE;
const { _electron: electron, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");

(async () => {
  if (process.platform !== "darwin")
    throw new Error("This check requires macOS");
  const profile = await fs.mkdtemp(path.resolve("build/macos-lifecycle-"));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await fs.mkdir(path.join(profile, "engine"));
  await fs.writeFile(
    path.join(profile, "engine/capture.json"),
    JSON.stringify({ http: true, wireguard: false, port, lan: false }),
  );
  let application;
  try {
    application = await electron.launch({
      executablePath: require("./desktop-build.cjs").executable,
      args: [],
      env: {
        ...process.env,
        CHLS_USER_DATA: profile,
        CHLS_SYSTEM_LOCALE: "en-US",
      },
    });
    const page = await application.firstWindow();
    await expect
      .poll(
        () =>
          page.evaluate(async () => (await window.chls.api("/status")).running),
        { timeout: 60000 },
      )
      .toBe(true);
    await page.evaluate(async () => {
      await window.chls.api("/mocks", "PUT", {
        source: 'from mitm_gui import Script\napp = Script("Lifecycle")',
        folder: "",
      });
      await window.chls.api("/mocks/control", "POST", { action: "enable" });
    });
    const enginePid = Number(
      execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
        encoding: "utf8",
      })
        .split("\n")
        .map((row) => row.trim().split(/\s+/))
        .find(
          (row) =>
            Number(row[1]) === application.process().pid &&
            row.slice(2).join(" ").endsWith("mitm-gui-engine"),
        )?.[0],
    );
    expect(enginePid).toBeGreaterThan(0);
    const workers = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
      encoding: "utf8",
    })
      .split("\n")
      .map((row) => row.trim().split(/\s+/))
      .filter((row) => Number(row[1]) === enginePid)
      .map((row) => Number(row[0]));
    expect(workers.length).toBeGreaterThan(0);

    expect(
      await application.evaluate(({ Menu }) =>
        Menu.getApplicationMenu().items[0].submenu.items.some(
          (item) => item.role === "quit",
        ),
      ),
    ).toBe(true);
    await page.keyboard.press("Meta+k");
    await expect(
      page.locator('input[type="search"], input[placeholder*="Search"]'),
    ).toBeFocused();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    ).toBe(false);
    process.kill(enginePid, 0);
    await application.evaluate(({ app }) => app.emit("activate"));
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.chls.api("/status")).running),
      )
      .toBe(true);
    const exited = new Promise((resolve) =>
      application.process().once("exit", resolve),
    );
    // CDP does not dispatch AppKit accelerators; assert the Quit role above,
    // then exercise its app.quit lifecycle directly.
    await application.evaluate(({ app }) => app.quit());
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("app.quit did not exit")), 15000).unref(),
      ),
    ]);
    application = null;
    await expect
      .poll(() => {
        try {
          process.kill(enginePid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    for (const pid of workers) {
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    }
    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          "Cmd+K",
          "native Quit menu",
          "close hides window and retains engine",
          "Dock activation restores window",
          "app.quit exits app, engine and script workers",
        ],
      }),
    );
  } finally {
    if (application) await application.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
