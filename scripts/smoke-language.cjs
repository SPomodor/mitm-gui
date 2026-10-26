const { _electron: electron, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");

(async () => {
  const output = path.resolve("build/language-smoke");
  await fs.mkdir(output, { recursive: true });
  const profiles = new Map();
  let application, page;
  const errors = [];
  async function launch(id, systemLocale) {
    let data = profiles.get(id);
    if (!data) {
      data = path.join(output, `${id}-${Date.now()}`);
      profiles.set(id, data);
      const server = net.createServer();
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      await new Promise((resolve) => server.close(resolve));
      await fs.mkdir(path.join(data, "engine"), { recursive: true });
      await fs.writeFile(
        path.join(data, "engine/capture.json"),
        JSON.stringify({ http: true, port, wireguard: false, lan: false }),
      );
    }
    application = await electron.launch({
      executablePath: path.resolve(
        process.env.CHLS_SMOKE_BUILD_DIR || "release",
        "win-unpacked/mitm gui.exe",
      ),
      args: [],
      env: {
        ...process.env,
        CHLS_USER_DATA: data,
        CHLS_SYSTEM_LOCALE: systemLocale,
      },
    });
    page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(page.locator(".language-control select")).toBeVisible();
  }
  const language = () => page.locator(".language-control select");
  const navigate = (name) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name: new RegExp("^" + name) })
      .click();
  const button = (name) => page.getByRole("button", { name, exact: true });
  async function finish() {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await application.close();
    application = null;
  }
  try {
    await launch("english", "en-US");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(language()).toHaveValue("auto");
    await expect(page.getByRole("heading", { name: /^Traffic/ })).toBeVisible();
    await navigate("Connect device");
    await expect(
      page.getByText("Choose your device and connection method."),
    ).toBeVisible();
    await button("Close").click();
    await navigate("Rules");
    await button("New rule").click();
    const editorWindow = await expect
      .poll(async () => (await application.windows()).length)
      .toBe(2);
    const rulePage = (await application.windows()).find((p) => p !== page);
    rulePage.on("pageerror", (e) => errors.push(e.message));
    await expect(
      rulePage.getByRole("button", { name: "Save rule", exact: true }),
    ).toBeVisible();
    await rulePage
      .getByLabel("Name", { exact: true })
      .fill("Пользовательское имя");
    await language().selectOption("ru");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(
      rulePage.getByRole("button", { name: "Сохранить правило", exact: true }),
    ).toBeVisible();
    await expect(rulePage.getByLabel("Название", { exact: true })).toHaveValue(
      "Пользовательское имя",
    );
    await expect(
      rulePage.getByRole("option", { name: "Поле JSON", exact: true }),
    ).toHaveCount(1);
    await language().selectOption("en");
    await expect(
      rulePage.getByRole("option", { name: "JSON field", exact: true }),
    ).toHaveCount(1);
    await rulePage.getByRole("button", { name: "Cancel", exact: true }).click();
    await navigate("Scripts");
    const code = () =>
      page.getByRole("textbox", {
        name: /^(Script code|Код сценария)$/,
        exact: true,
      });
    await expect(code()).toBeVisible();
    await expect(page.getByLabel("Script name", { exact: true })).toHaveValue(
      "Example · example.com",
    );
    await button("Validate").click();
    await expect(page.locator(".mock-notice")).toContainText(
      "Validated: 2 stages",
    );
    await language().selectOption("ru");
    await expect(page.locator(".mock-notice")).toContainText(
      "Проверено: 2 этапов",
    );
    await language().selectOption("en");
    const source =
      '# Не переводить пользовательский код\nfrom chls import Script\napp = Script("Мой код")';
    await code().press("Control+a");
    await page.keyboard.insertText(source);
    await code().press("Control+f");
    await page.getByLabel("Find in script", { exact: true }).fill("Script");
    await language().selectOption("ru");
    await expect(
      page.getByLabel("Найти в скрипте", { exact: true }),
    ).toHaveValue("Script");
    await expect(code()).toContainText("Не переводить пользовательский код");
    await page.getByLabel("Найти в скрипте", { exact: true }).press("Escape");
    await language().selectOption("en");
    await code().press("Control+s");
    await expect(page.locator(".mock-notice")).toContainText(
      "Saved to the library",
    );
    const saved = await page.evaluate(() => window.chls.scriptLibrary());
    expect(saved.items[0].source).toBe(source);
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async (_, options) => {
        globalThis.dialogTitle = options.title;
        return { canceled: true, filePaths: [] };
      };
    });
    await button("Choose JSON folder").click();
    expect(await application.evaluate(() => globalThis.dialogTitle)).toBe(
      "JSON response folder",
    );
    await page.setViewportSize({ width: 1024, height: 682 });
    await expect(language()).toBeInViewport({ ratio: 1 });
    await expect(button("Apply script")).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: path.join(output, "english-compact.png") });
    await application.close();
    application = null;
    await launch("english", "ru-RU");
    await expect(language()).toHaveValue("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await language().selectOption("auto");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await application.close();
    application = null;
    await launch("fallback", "de-DE");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await language().selectOption("ru");
    await expect(page.getByRole("heading", { name: /^Трафик/ })).toBeVisible();
    await application.close();
    application = null;
    await launch("russian", "ru-RU");
    await expect(language()).toHaveValue("auto");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    expect(errors).toEqual([]);
    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          "automatic Russian/English/fallback",
          "manual choice and restart",
          "live cross-window translation",
          "drafts and script source preserved",
          "translated dynamic notices",
          "open editor search survives language change",
          "native folder dialog",
          "compact English layout",
        ],
      }),
    );
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, "failure.png") });
      console.error((await page.locator("body").innerText()).slice(-4000));
    }
    throw error;
  } finally {
    if (application) await finish();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
