const { _electron: electron, chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const dgram = require("node:dgram");
const { version } = require("../package.json");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

(async () => {
  const output = path.resolve("build/ui-smoke");
  await fs.mkdir(output, { recursive: true });
  const errors = [];
  const proxyPort = await unusedPort();
  const udp = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(0, "127.0.0.1", resolve);
  });
  const wireguardPort = udp.address().port;
  await new Promise((resolve) => udp.close(resolve));
  const buildDirectory = process.env.CHLS_SMOKE_BUILD_DIR || "release";
  const portable = process.argv.includes("--portable");
  const packaged = portable || process.argv.includes("--packaged");
  const launchOptions = {
    ...(packaged
      ? {
          executablePath: path.resolve(
            portable
              ? path.join(buildDirectory, `CHLS-${version}.exe`)
              : path.join(buildDirectory, "win-unpacked/CHLS.exe"),
          ),
          args: [],
        }
      : { args: [path.resolve(".")] }),
    env: {
      ...process.env,
      CHLS_USER_DATA: path.join(
        output,
        (packaged ? "packaged-data-" : "dev-data-") + Date.now(),
      ),
    },
    timeout: 60000,
  };
  const engineData = path.join(launchOptions.env.CHLS_USER_DATA, "engine");
  await fs.mkdir(engineData, { recursive: true });
  await fs.writeFile(
    path.join(engineData, "capture.json"),
    JSON.stringify({
      http: true,
      wireguard: true,
      port: proxyPort,
      wg_port: wireguardPort,
      lan: false,
    }),
  );
  // The NSIS portable wrapper does not forward the inspector stdout that
  // Playwright's Electron launcher expects. Attach to its Chromium endpoint.
  let application;
  if (portable) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const child = spawn(
      launchOptions.executablePath,
      [`--remote-debugging-port=${port}`],
      { env: launchOptions.env, stdio: "ignore", windowsHide: true },
    );
    let browser;
    for (let i = 0; i < 300; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 1000,
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!browser) {
      child.kill();
      throw new Error("Portable app did not expose its test endpoint");
    }
    application = {
      firstWindow: async () => {
        for (let i = 0; i < 100; i++) {
          const page = browser.contexts()[0]?.pages()[0];
          if (page) return page;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Portable window not found");
      },
      close: async () => {
        for (const page of browser.contexts()[0].pages()) await page.close();
        await browser.close();
      },
    };
  } else application = await electron.launch(launchOptions);
  const electronProcess = portable ? null : application.process();
  let upstream;
  try {
    const page = await application.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    async function openEditor(action) {
      const opened = page.context().waitForEvent("page");
      await action();
      const editor = await opened;
      editor.on("pageerror", (e) => errors.push(e.message));
      await expect(
        editor.getByLabel("Название", { exact: true }),
      ).toBeVisible();
      return editor;
    }
    async function saveEditor(editor) {
      await Promise.all([
        editor.waitForEvent("close"),
        editor.getByRole("button", { name: "Сохранить правило" }).click(),
      ]);
    }
    await expect(
      page.getByRole("button", { name: "Остановить", exact: true }),
    ).toBeEnabled({ timeout: 60000 });
    await page.locator(".bottom-meta select").selectOption("dark");
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "01-traffic.png"),
    });
    await page
      .getByRole("button", { name: "Подключение", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.locator(".certificate-instructions .device-selector"),
    ).toBeVisible();
    await expect(page.locator(".certificate-address > span")).toHaveText(
      "mitm.it",
    );
    await expect(page.locator(".certificate-instructions")).toContainText(
      "Network Security Config",
    );
    await page.getByRole("button", { name: "iPhone", exact: true }).click();
    await expect(page.locator(".certificate-instructions")).toContainText(
      "Включите полное доверие",
    );
    await page
      .getByRole("button", { name: "HTTP-прокси", exact: true })
      .click();
    await expect(page.locator(".connection-main")).toContainText(
      "Аутентификацию оставьте выключенной",
    );
    await page.locator(".connection-main").evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "00-iphone-setup.png"),
    });
    await page.getByRole("button", { name: "Android", exact: true }).click();
    await page.getByRole("button", { name: "WireGuard", exact: true }).click();
    const smallFont = await page
      .locator(".connection-main p")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    if (smallFont < 12)
      throw new Error(`Setup font is smaller than 12px: ${smallFont}`);
    await page.locator(".connection-main").evaluate((el) => (el.scrollTop = 0));
    await expect(page.locator(".qr svg")).toBeVisible({ timeout: 20000 });
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "02-wireguard.png"),
    });
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    upstream = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          app: "CHLS",
          enabled: false,
          environment: "development",
          features: { rewrite: true, mapLocal: true, blocklist: true },
          request: req.url,
        }),
      );
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const originPort = upstream.address().port;
    async function fetchProxy(
      url,
      host = `api.example.test:${originPort}`,
      method = "GET",
      extraHeaders = {},
      body,
    ) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: proxyPort,
            path: url,
            method,
            headers: { Host: host, ...extraHeaders },
          },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, text }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    }
    const url = `http://127.0.0.1:${originPort}/api/config`;
    const result = await fetchProxy(url);
    if (result.status !== 200) throw new Error(JSON.stringify(result));
    await expect(page.locator(".flow-row").first()).toBeVisible({
      timeout: 15000,
    });
    await page.locator(".flow-row").first().click();
    await expect(page.locator(".flow-host").first()).toHaveText(
      "api.example.test",
    );
    await expect(page.locator(".code-view")).toContainText("CHLS");
    await page.keyboard.press("Control+f");
    await expect(
      page.getByLabel("Найти в теле", { exact: true }),
    ).toBeFocused();
    await page.getByLabel("Найти в теле", { exact: true }).fill("true");
    await expect(page.locator(".searched-code mark")).toHaveCount(3);
    await expect(page.locator(".body-search [role=status]")).toHaveText("1/3");
    await page.getByLabel("Найти в теле", { exact: true }).press("Enter");
    await expect(page.locator(".body-search [role=status]")).toHaveText("2/3");
    await page.getByLabel("Найти в теле", { exact: true }).press("Shift+Enter");
    await expect(page.locator(".body-search [role=status]")).toHaveText("1/3");
    await page.getByLabel("Найти в теле", { exact: true }).fill("no-such-text");
    await expect(page.locator(".body-search [role=status]")).toHaveText("0/0");
    await page.getByLabel("Найти в теле", { exact: true }).press("Escape");
    await expect(page.getByLabel("Найти в теле", { exact: true })).toHaveCount(
      0,
    );
    await page.getByLabel("Фокус: api.example.test", { exact: true }).click();
    await page
      .getByRole("button", { name: "Только фокус", exact: true })
      .click();
    await expect(page.locator(".flow-row")).toHaveCount(1);
    await page.getByLabel("Фокус: api.example.test", { exact: true }).click();
    await expect(page.locator(".flow-row")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Только фокус", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Пауза записи", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Включить запись", exact: true }),
    ).toBeVisible();
    await fetchProxy(url + "?not-recorded=1");
    const saved = await page.evaluate(() => window.chls.api("/flows"));
    if (saved.length !== 1)
      throw new Error("Recording pause still stores traffic");
    await page
      .getByRole("button", { name: "Включить запись", exact: true })
      .click();
    await page.getByRole("button", { name: "SSL вкл", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "SSL выкл", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "SSL выкл", exact: true }).click();
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "03-inspector.png"),
    });
    await page.locator(".flow-row").first().click({ button: "right" });
    let editor = await openEditor(() =>
      page
        .getByRole("button", { name: "Создать Rewrite", exact: true })
        .click(),
    );
    await expect(editor.getByLabel("Хост", { exact: true })).toHaveValue(
      "api.example.test",
    );
    await editor
      .getByLabel("Путь", { exact: true })
      .fill("https://site.net/report?encrypted_request=1&deviceid=c6ebaf69c6");
    await expect(editor.getByLabel("Путь", { exact: true })).toHaveValue(
      "/report",
    );
    await expect(
      editor.getByLabel("Query string", { exact: true }),
    ).toHaveValue("encrypted_request=1&deviceid=c6ebaf69c6");
    await expect(editor.getByLabel("Хост", { exact: true })).toHaveValue(
      "site.net",
    );
    await editor.getByLabel("Хост", { exact: true }).fill("api.example.test");
    await editor.getByLabel("Путь", { exact: true }).fill("/api/config");
    await editor.getByLabel("Query string", { exact: true }).fill("");
    await editor
      .getByLabel("Название", { exact: true })
      .fill("Enable feature flag");
    await editor
      .getByRole("button", { name: "К запросам", exact: true })
      .click();
    await page.bringToFront();
    await page.locator(".flow-row").first().click({ button: "right" });
    await page
      .getByRole("button", { name: "Копировать URL", exact: true })
      .click();
    await editor.bringToFront();
    await expect(editor.getByLabel("Название", { exact: true })).toHaveValue(
      "Enable feature flag",
    );
    await editor.getByLabel("Название", { exact: true }).fill("");
    await editor.getByLabel("Название", { exact: true }).press("Control+V");
    await expect(editor.getByLabel("Название", { exact: true })).toHaveValue(
      url.replace("127.0.0.1", "api.example.test"),
    );
    await editor
      .getByLabel("Название", { exact: true })
      .fill("Enable feature flag");
    await editor.getByLabel("Что изменить").selectOption("json");
    await editor.getByLabel("Путь поля через точку").fill("enabled");
    await editor.getByLabel("Новое значение JSON").fill("true");
    await editor.screenshot({
      path: path.join(output, "08-rule-window.png"),
      animations: "disabled",
    });
    await saveEditor(editor);
    const rewritten = await fetchProxy(url);
    if (JSON.parse(rewritten.text).enabled !== true)
      throw new Error("UI-created Rewrite did not apply");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Правила/ })
      .click();
    await expect(page.locator(".rule-row")).toHaveCount(1);
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "04-rules.png"),
    });
    await page.getByRole("switch").click();
    await expect(page.getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    if (JSON.parse((await fetchProxy(url)).text).enabled !== false)
      throw new Error("Disabled rule still applies");
    editor = await openEditor(() =>
      page.getByRole("button", { name: "Новое правило", exact: true }).click(),
    );
    await editor
      .getByLabel("Название", { exact: true })
      .fill("Status 200 → 404");
    await editor.getByLabel("Что изменить").selectOption("status");
    await expect(
      editor.getByRole("combobox", { name: "Стадия", exact: true }),
    ).toHaveValue("response");
    await editor.getByLabel("Значение для поиска", { exact: true }).fill("200");
    await editor.getByLabel("Новое значение", { exact: true }).fill("404");
    await editor
      .locator(".form-content")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await editor.screenshot({
      animations: "disabled",
      path: path.join(output, "06-status-rewrite.png"),
    });
    await saveEditor(editor);
    if ((await fetchProxy(url)).status !== 404)
      throw new Error("UI-created status Rewrite did not apply");
    editor = await openEditor(() =>
      page.getByRole("button", { name: "Новое правило", exact: true }).click(),
    );
    await editor
      .getByLabel("Название", { exact: true })
      .fill("Body regex groups");
    await editor.getByLabel("Что изменить").selectOption("body");
    await editor.getByLabel("Regex", { exact: true }).check();
    await editor
      .getByLabel("Значение для поиска", { exact: true })
      .fill('("enabled":\\s*)false');
    await editor.getByLabel("Новое значение", { exact: true }).fill("$1true");
    await saveEditor(editor);
    if (JSON.parse((await fetchProxy(url)).text).enabled !== true)
      throw new Error("UI-created regex body Rewrite did not apply");
    editor = await openEditor(() =>
      page.getByRole("button", { name: "Новое правило", exact: true }).click(),
    );
    await editor
      .getByLabel("Название", { exact: true })
      .fill("Add debug query");
    await editor.getByLabel("Что изменить").selectOption("query_add");
    await expect(
      editor.getByRole("combobox", { name: "Стадия", exact: true }),
    ).toHaveValue("request");
    await editor.getByLabel("Новое имя", { exact: true }).fill("debug");
    await editor.getByLabel("Новое значение", { exact: true }).fill("yes");
    await saveEditor(editor);
    if (
      JSON.parse((await fetchProxy(url)).text).request !==
      "/api/config?debug=yes"
    )
      throw new Error("UI-created query Rewrite did not apply");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Трафик/ })
      .click();
    await expect(page.locator(".flow-row").first()).toContainText("debug=yes");
    await page.locator(".flow-row").first().click({ button: "right" });
    editor = await openEditor(() =>
      page
        .getByRole("button", { name: "Создать Rewrite", exact: true })
        .click(),
    );
    await expect(editor.getByLabel("Путь", { exact: true })).toHaveValue(
      "/api/config",
    );
    await Promise.all([
      editor.waitForEvent("close"),
      editor.getByRole("button", { name: "Отмена", exact: true }).click(),
    ]);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Правила/ })
      .click();
    // Verify both themes and the minimum supported window size.
    const firstEditor = await openEditor(() =>
      page.locator(".rule-main").nth(0).click(),
    );
    await firstEditor.setViewportSize({ width: 540, height: 470 });
    await expect(
      firstEditor.getByRole("button", { name: "Сохранить правило" }),
    ).toBeInViewport();
    const secondEditor = await openEditor(() =>
      page.locator(".rule-main").nth(1).click(),
    );
    await firstEditor
      .getByLabel("Название", { exact: true })
      .fill("Saved from editor one");
    await secondEditor
      .getByLabel("Название", { exact: true })
      .fill("Saved from editor two");
    // Opening an existing editor focuses it without resetting its draft.
    const windowCount = page.context().pages().length;
    await page.locator(".rule-main").nth(0).click();
    await expect(
      firstEditor.getByLabel("Название", { exact: true }),
    ).toHaveValue("Saved from editor one");
    if (page.context().pages().length !== windowCount)
      throw new Error("Duplicate editor window");
    await page.getByLabel("Тема оформления").selectOption("light");
    await expect(firstEditor.locator("html")).toHaveAttribute(
      "data-theme",
      "light",
    );
    await expect(secondEditor.locator("html")).toHaveAttribute(
      "data-theme",
      "light",
    );
    await Promise.all([
      saveEditor(firstEditor),
      Promise.all([
        secondEditor.waitForEvent("close"),
        secondEditor
          .getByLabel("Название", { exact: true })
          .press("Control+s")
          .catch((error) => {
            if (!secondEditor.isClosed()) throw error;
          }),
      ]),
    ]);
    await expect(
      page.locator(".rule-main").filter({ hasText: "Saved from editor one" }),
    ).toHaveCount(1);
    await expect(
      page.locator(".rule-main").filter({ hasText: "Saved from editor two" }),
    ).toHaveCount(1);
    await expect(page.locator(".rule-row")).toHaveCount(4);
    await page.getByLabel("Тема оформления").selectOption("light");
    if (portable) await page.setViewportSize({ width: 1024, height: 681 });
    else
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1040, 720),
      );
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "05-light-compact.png"),
    });
    await page.locator(".bottom-meta select").selectOption("dark");
    await page
      .getByRole("button", { name: /^Переименовать:/ })
      .first()
      .click();
    await page
      .getByLabel("Название сессии", { exact: true })
      .fill("Phone debugging");
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.locator(".session-item").first()).toHaveText(
      "Phone debugging",
    );
    if (!portable) {
      const exportPath = path.join(output, `session-${Date.now()}.har`);
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, exportPath);
      await page
        .getByRole("button", {
          name: "Экспортировать HAR: Phone debugging",
          exact: true,
        })
        .click();
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await fs.readFile(exportPath, "utf8")).log.entries
              .length;
          } catch {
            return 0;
          }
        })
        .toBeGreaterThan(0);
      const archive = JSON.parse(await fs.readFile(exportPath, "utf8"));
      if (archive.log._chlsSession.name !== "Phone debugging")
        throw new Error("Exported session name was lost");
    }
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "07-sessions.png"),
    });
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Сценарии/ })
      .click();
    if (
      !(await page.evaluate(() => window.chls.mockOrderTemplate())).includes(
        "6_complete_exchange_init.json",
      )
    )
      throw new Error("Bundled order template is missing");
    await page.getByRole("button", { name: "Демо", exact: true }).click();
    await page.getByLabel("Домены сценария").fill("api.example.test");
    await page.getByRole("checkbox", { name: /^Все домены/ }).check();
    await expect(page.getByLabel("Домены сценария")).toBeDisabled();
    await page.getByRole("button", { name: "Проверить", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Проверено: 7 этапов");
    await page
      .getByRole("button", { name: "Применить сценарий", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Включить сценарий", exact: true })
      .click();
    const mockUrl = `http://127.0.0.1:${originPort}/driver/demo/order`;
    if (JSON.parse((await fetchProxy(mockUrl)).text).status !== "assembling")
      throw new Error("Demo mock did not intercept request");
    if (
      JSON.parse((await fetchProxy(mockUrl, "another.example.test")).text)
        .status !== "assembling"
    )
      throw new Error("All-host mock did not match a second domain");
    await page.getByRole("button", { name: "Завершён", exact: true }).click();
    if (JSON.parse((await fetchProxy(mockUrl)).text).status !== "completed")
      throw new Error("Mock stage did not switch");
    await expect(page.locator(".mock-log-list")).toContainText(
      "/driver/demo/order",
    );
    if ((await fetchProxy(mockUrl + "/unhandled")).status !== 501)
      throw new Error("Strict mock scope did not block unmatched request");
    const originalSource = await page.getByLabel("Код сценария").inputValue();
    await page
      .getByLabel("Код сценария")
      .fill(originalSource + "\nневерная команда");
    await page
      .getByRole("button", { name: "Применить сценарий", exact: true })
      .click();
    await expect(page.locator(".mocks-page").getByRole("alert")).toContainText(
      "Строка",
    );
    if (JSON.parse((await fetchProxy(mockUrl)).text).status !== "completed")
      throw new Error("Failed apply replaced working mock");
    await page.getByLabel("Код сценария").fill(originalSource);
    await page
      .getByRole("button", { name: "Сбросить этап", exact: true })
      .click();
    if (JSON.parse((await fetchProxy(mockUrl)).text).status !== "assembling")
      throw new Error("Mock reset failed");
    await page.getByLabel("Режим сценария").selectOption("scenario");
    await expect(page.getByLabel("Режим сценария")).toHaveValue("scenario");
    await expect(
      page.getByRole("button", { name: "В магазин", exact: true }),
    ).toBeDisabled();
    const confirmUrl = `http://127.0.0.1:${originPort}/driver/v1/cargo-pro-api/grocery/v1/order/exchange/confirm`;
    const arriveUrl = `http://127.0.0.1:${originPort}/driver/v1/cargo-pro-api/grocery/v1/order/arrive-at-point`;
    await fetchProxy(confirmUrl, undefined, "POST", {
      "Idempotency-Key": "ui-accept",
    });
    await expect(
      page.getByRole("button", { name: "В магазин", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await fetchProxy(arriveUrl, undefined, "POST", {
      "Idempotency-Key": "ui-arrive-store",
    });
    if (JSON.parse((await fetchProxy(mockUrl)).text).status !== "at_store")
      throw new Error("Arrive trigger did not advance the scenario");
    await fetchProxy(confirmUrl, undefined, "POST", {
      "Idempotency-Key": "ui-pickup",
    });
    await fetchProxy(arriveUrl, undefined, "POST", {
      "Idempotency-Key": "ui-arrive-client",
    });
    await fetchProxy(confirmUrl, undefined, "POST", {
      "Idempotency-Key": "ui-deliver",
    });
    await fetchProxy(confirmUrl, undefined, "POST", {
      "Idempotency-Key": "ui-deliver",
    });
    if (JSON.parse((await fetchProxy(mockUrl)).text).status !== "returning")
      throw new Error("Duplicate confirm skipped a stage");
    await fetchProxy(confirmUrl, undefined, "POST", {
      "Idempotency-Key": "ui-return",
    });
    await expect(
      page.getByRole("button", { name: "Завершён", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".mock-log-list")).toContainText(
      "Вернуться → Завершён",
    );
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "09-mock-module.png"),
    });
    await expect(
      page.getByRole("button", { name: "Применить сценарий", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.getByLabel("Режим сценария").selectOption("free");
    await expect(
      page.getByRole("button", { name: "В магазин", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Трафик/ })
      .click();
    await expect(
      page.getByText("Сценарий активен", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Сценарии/ })
      .click();
    await expect(page.getByLabel("Код сценария")).toHaveValue(originalSource);
    await page
      .getByRole("button", { name: "Выключить сценарий", exact: true })
      .click();
    if (JSON.parse((await fetchProxy(mockUrl)).text).app !== "CHLS")
      throw new Error("Normal proxy did not resume after disabling mock");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Правила/ })
      .click();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Трафик/ })
      .click();
    await fetchProxy(
      `http://127.0.0.1:${originPort}/search-request`,
      `api.example.test:${originPort}`,
      "POST",
      { "Content-Type": "application/json" },
      JSON.stringify({ order_id: "ABC-123", repeat: "ABC-123" }),
    );
    await expect(page.locator(".flow-row").first()).toContainText(
      "/search-request",
    );
    await page.locator(".flow-row").first().click();
    await page.getByRole("button", { name: "Request", exact: true }).click();
    await page.getByRole("button", { name: "Headers", exact: true }).click();
    await page.keyboard.press("Control+f");
    await expect(
      page.getByLabel("Найти в теле", { exact: true }),
    ).toBeFocused();
    await page.getByLabel("Найти в теле", { exact: true }).fill("ABC-123");
    await expect(page.locator(".searched-code mark")).toHaveCount(2);
    await page.screenshot({
      animations: "disabled",
      path: path.join(output, "10-body-search.png"),
    });
    await page.getByLabel("Найти в теле", { exact: true }).press("Escape");
    await page
      .getByRole("button", { name: "Очистить текущую сессию", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Удалить", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".flow-row")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Новая сессия", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Phone debugging", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Удалить сессию: Phone debugging",
        exact: true,
      })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Удалить", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Удалить сессию: Phone debugging",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Правила/ })
      .click();
    await page.getByRole("button", { name: "Остановить", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Начать захват", exact: true }),
    ).toBeEnabled();
    if (!portable) {
      await openEditor(() =>
        page
          .getByRole("button", { name: "Новое правило", exact: true })
          .click(),
      );
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find(
            (target) => !target.webContents.getURL().endsWith("#rule-editor"),
          )
          .close();
      });
      await expect
        .poll(() => electronProcess.exitCode, { timeout: 10000 })
        .not.toBeNull();
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(
      JSON.stringify({
        ok: true,
        packaged,
        screenshots: output,
        checks: [
          "startup",
          "wireguard QR",
          "real capture",
          "inspector",
          "Ctrl+F in response and request JSON, highlights, next/previous, no match, Escape",
          "Ctrl+F opens body search from Headers",
          "host focus filters display without dropping capture",
          "recording pause keeps proxy working and does not save requests",
          "SSL toggle",
          "pasted URL splits host, path and query",
          "clear session traffic through app dialog",
          "delete selected old session and return to current session",
          "create Rewrite",
          "separate non-modal rule window",
          "copy URL from main window while draft stays open",
          "two editors save independently",
          "existing editor keeps draft when reopened",
          "theme sync across windows",
          "disable rule",
          "Response Status 200 to 404",
          "body regex groups",
          "query parameter addition",
          "original location in new rules",
          "light theme",
          "compact window",
          "rename session",
          ...(!portable ? ["export HAR through native save dialog"] : []),
          "stop",
          "mock DSL validation and demo",
          "all-host mock toggle with two domains",
          "manual mock stages and reset",
          "scenario mode triggers for arrive and confirm",
          "duplicate confirm does not skip stages",
          "switching back to free mode restores manual stage selection",
          "strict unmatched request blocking",
          "invalid mock keeps active revision",
          "disabled mock restores normal proxy",
          ...(!portable
            ? ["closing main window also closes editor and exits app"]
            : []),
        ],
        rendererErrors: errors,
      }),
    );
  } finally {
    upstream?.close();
    if (portable || electronProcess.exitCode === null)
      await application.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
