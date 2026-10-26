delete process.env.ELECTRON_RUN_AS_NODE;
const { _electron: electron, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

(async () => {
  const output = path.resolve("build/script-library-smoke");
  const data = path.join(output, `data-${Date.now()}`);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await fs.mkdir(path.join(data, "engine"), { recursive: true });
  await fs.writeFile(
    path.join(data, "engine/capture.json"),
    JSON.stringify({ http: true, port, wireguard: false, lan: false }),
  );
  const launch = (profile = data) =>
    electron.launch({
      executablePath: require("./desktop-build.cjs").executable,
      args: [],
      env: {
        ...process.env,
        CHLS_SYSTEM_LOCALE: "ru-RU",
        CHLS_USER_DATA: profile,
      },
    });
  const proxy = (pathname, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "http://example.com" + pathname,
          method,
          headers: { Host: "example.com" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(JSON.parse(body)));
        },
      );
      req.on("error", reject);
      req.end();
    });
  let app = await launch();
  let page = await app.firstWindow();
  const errors = [];
  async function open() {
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Сценарии/ })
      .click();
    await expect(
      page.getByLabel("Название сценария", { exact: true }),
    ).not.toHaveValue("");
  }
  const button = (name) => page.getByRole("button", { name, exact: true });
  const name = () => page.getByLabel("Название сценария", { exact: true });
  const picker = () => page.getByLabel("Выбрать сценарий", { exact: true });
  const library = () => page.evaluate(() => window.chls.scriptLibrary());
  try {
    await open();
    await expect(button("Шаблон 187")).toHaveCount(0);
    const initial = await library();
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0].source).toContain('hosts=["example.com"]');
    expect(initial.items[0].source).not.toContain("187");
    const first = initial.selected;
    await button("Применить сценарий").click();
    await button("Включить сценарий").click();
    expect((await proxy("/api/hello")).visits).toBe(1);
    expect((await proxy("/api/hello")).visits).toBe(2);
    expect(await proxy("/api/finish", "POST")).toEqual({ done: true });
    expect((await proxy("/api/result")).message).toContain("завершён");
    await expect(button("Готово")).toHaveAttribute("aria-pressed", "true");

    await button("Дублировать сценарий").click();
    await name().fill("Мой пример");
    await page
      .getByLabel("Папка JSON", { exact: true })
      .fill("C:\\test-fixtures");
    await name().press("ControlOrMeta+s");
    await expect
      .poll(async () => (await library()).items[1].name)
      .toBe("Мой пример");
    const second = (await library()).selected;
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.chls.api("/mocks")).stage),
      )
      .toBe("Готово");
    // Saving another script must preserve the active state and fixtures.
    expect((await proxy("/api/hello")).visits).toBe(3);
    await page.getByLabel("Поиск сценариев").fill("example.com");
    await expect(picker().locator("option")).toHaveCount(2);
    await picker().selectOption(first);
    await expect(name()).toHaveValue("Пример · example.com");
    await page.getByLabel("Поиск сценариев").fill("Мой");
    await picker().selectOption(second);
    await expect(page.getByLabel("Папка JSON", { exact: true })).toHaveValue(
      "C:\\test-fixtures",
    );
    await page.getByLabel("Поиск сценариев").fill("");
    await name().fill("Несохранённое название");
    await picker().selectOption(first);
    const dialog = page.getByRole("dialog", { name: "Сохранить изменения?" });
    await expect(dialog).toBeVisible();
    await button("Отмена").click();
    await expect(name()).toHaveValue("Несохранённое название");
    await picker().selectOption(first);
    await button("Не сохранять").click();
    await expect(name()).toHaveValue("Пример · example.com");
    await picker().selectOption(second);
    await expect(name()).toHaveValue("Мой пример");
    await name().fill("Сохранено перед переходом");
    await picker().selectOption(first);
    await button("Сохранить и продолжить").click();
    await expect(name()).toHaveValue("Пример · example.com");
    await page.getByLabel("Поиск сценариев").fill("");
    await picker().selectOption(second);
    await expect(name()).toHaveValue("Сохранено перед переходом");
    await button("Новый").click();
    const third = (await library()).selected;
    await button("Удалить сценарий").click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Удалить", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await library()).items.some((item) => item.id === third),
      )
      .toBe(false);
    await picker().selectOption(second);
    await page.setViewportSize({ width: 1024, height: 682 });
    await expect(button("Сохранить")).toBeInViewport({ ratio: 1 });
    await expect(button("Применить сценарий")).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: path.join(output, "library-compact.png") });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await open();
    await expect(name()).toHaveValue("Сохранено перед переходом");
    await expect(page.getByLabel("Папка JSON", { exact: true })).toHaveValue(
      "C:\\test-fixtures",
    );
    expect((await library()).items).toHaveLength(2);
    await expect(button("Включить сценарий")).toBeVisible();
    await app.close();
    const migratedProfile = data + "-migration";
    await fs.mkdir(path.join(migratedProfile, "engine"), { recursive: true });
    await fs.writeFile(
      path.join(migratedProfile, "engine/capture.json"),
      JSON.stringify({ http: true, port, wireguard: false, lan: false }),
    );
    const previousSource =
      'from chls import Script\napp = Script("Мой старый 187")\n# пользовательский код';
    await fs.writeFile(
      path.join(migratedProfile, "engine/script-module.json"),
      JSON.stringify({ version: 2, source: previousSource, folder: "" }),
    );
    app = await launch(migratedProfile);
    page = await app.firstWindow();
    await open();
    await expect(name()).toHaveValue("Мой старый 187");
    const migrated = await library();
    expect(migrated.items).toHaveLength(1);
    expect(migrated.items[0].source).toBe(previousSource);
    expect(errors).toEqual([]);

    console.log(
      JSON.stringify({
        ok: true,
        data,
        checks: [
          "example HTTP responses and state transitions",
          "save without activation",
          "create/copy/rename/search/switch/delete",
          "Ctrl+S",
          "cancel/discard/save unsaved changes",
          "compact layout",
          "restart restores library, folder and selection",
          "migration preserves existing user script",
        ],
      }),
    );
  } catch (error) {
    await page.screenshot({ path: path.join(output, "failure.png") });
    console.error((await page.locator("body").innerText()).slice(-4000));
    throw error;
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
