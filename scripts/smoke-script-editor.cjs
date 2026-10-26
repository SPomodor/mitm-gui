delete process.env.ELECTRON_RUN_AS_NODE;
const { _electron: electron, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");

(async () => {
  const output = path.resolve("build/script-editor-smoke");
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
  const packaged = process.argv.includes("--packaged");
  const application = await electron.launch({
    ...(packaged
      ? {
          executablePath: require("./desktop-build.cjs").executable,
          args: [],
        }
      : { args: [path.resolve(".")] }),
    env: { ...process.env, CHLS_SYSTEM_LOCALE: "ru-RU", CHLS_USER_DATA: data },
  });
  const page = await application.firstWindow();
  try {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Сценарии/ })
      .click();
    const editor = page.getByRole("textbox", {
      name: "Код сценария",
      exact: true,
    });
    const lines = editor.locator(".cm-line");
    // CodeMirror virtualizes its DOM. Replace the document through its real
    // select-all key binding, rather than Playwright's DOM-only fill().
    async function setCode(text) {
      await editor.press("ControlOrMeta+a");
      await page.keyboard.insertText(text);
    }

    await setCode("value = 1\nother = 2");
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    await editor.press("Tab");
    await expect(lines.nth(0)).toHaveText(/^ {4}value = 1$/);
    await editor.press("ControlOrMeta+z");
    await expect(lines.nth(0)).toHaveText("value = 1");
    await editor.press(
      process.platform === "darwin" ? "Meta+Shift+z" : "Control+y",
    );
    await expect(lines.nth(0)).toHaveText(/^ {4}value = 1$/);
    await editor.press("Shift+Tab");
    await expect(lines.nth(0)).toHaveText("value = 1");
    await editor.press("ControlOrMeta+a");
    await editor.press("Tab");
    expect(await lines.allTextContents()).toEqual([
      "    value = 1",
      "    other = 2",
    ]);
    await editor.press("Shift+Tab");
    expect(await lines.allTextContents()).toEqual(["value = 1", "other = 2"]);
    await setCode("if True:");
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
    );
    await editor.press("Enter");
    await page.keyboard.insertText("value = 1");
    await expect(lines.nth(1)).toHaveText(/^ {4}value = 1$/);

    const highlighted =
      '# comment\nfrom chls import Script\napp = Script("test")\nvalue = 42\nflag = True';
    await setCode(highlighted);
    await expect(editor.locator(".script-token-keyword").first()).toBeVisible();
    await expect(editor.locator(".script-token-string")).toHaveText('"test"');
    await expect(editor.locator(".script-token-comment")).toHaveText(
      "# comment",
    );
    await expect(editor.locator(".script-token-value").first()).toHaveText(
      "42",
    );
    for (const theme of ["dark", "light"]) {
      await page.getByLabel("Тема оформления").selectOption(theme);
      await editor.press(
        process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
      );
      await page.screenshot({ path: path.join(output, `editor-${theme}.png`) });
      const colors = await editor
        .locator(".script-token-keyword")
        .first()
        .evaluate((element) => ({
          token: getComputedStyle(element).color,
          text: getComputedStyle(element.closest(".cm-content")).color,
        }));
      expect(colors.token).not.toBe(colors.text);
    }

    await setCode("needle = 1\nmessage = 'needle'\nlast = 'NEEDLE'");
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    await editor.press("ControlOrMeta+f");
    const input = page.getByRole("textbox", {
      name: "Найти в скрипте",
      exact: true,
    });
    const search = page.getByRole("search", { name: "Поиск в скрипте" });
    await expect(input).toBeFocused();
    await input.fill("needle");
    await expect(search.getByRole("status")).toHaveText("1/3");
    await input.press("Enter");
    await expect(search.getByRole("status")).toHaveText("2/3");
    await input.press("Shift+Enter");
    await expect(search.getByRole("status")).toHaveText("1/3");
    await expect(page.locator(".cm-searchMatch")).toHaveCount(3);
    await input.fill("not present");
    await expect(search.getByRole("status")).toHaveText("0/0");
    await expect(
      search.getByRole("button", { name: "Следующее совпадение в скрипте" }),
    ).toBeDisabled();
    await input.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(editor).toBeFocused();
    await page.getByRole("button", { name: "Открыть поиск в скрипте" }).click();
    await expect(input).toBeFocused();
    await input.press("Escape");
    expect(await lines.allTextContents()).toEqual([
      "needle = 1",
      "message = 'needle'",
      "last = 'NEEDLE'",
    ]);

    await setCode(
      "# needle first\n" + "value = 1\n".repeat(1500) + "# needle last",
    );
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    await editor.press("ControlOrMeta+f");
    await input.fill("needle");
    await expect(search.getByRole("status")).toHaveText("1/2");
    await input.press("Enter");
    await expect(search.getByRole("status")).toHaveText("2/2");
    await expect(editor).toContainText("# needle last");
    expect(await lines.count()).toBeLessThan(1502);
    await input.press("Escape");

    const source =
      'from chls import Script, response\napp = Script("Editor draft")\n@app.get("/driver/test")\ndef test(request, ctx):\n    return response(200)';
    await setCode(source);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Трафик/ })
      .click();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Сценарии/ })
      .click();
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    await expect(editor).toContainText('app = Script("Editor draft")');
    await page
      .getByRole("button", { name: "Применить сценарий", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.chls.api("/mocks")).source),
      )
      .toBe(source);
    await editor.click();
    await editor.press("Control+m");
    await editor.press("Tab");
    await expect(editor).not.toBeFocused();
    await page.setViewportSize({ width: 1024, height: 682 });
    await expect(
      page.getByRole("button", { name: "Применить сценарий", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    await page.screenshot({ path: path.join(output, "editor-compact.png") });
    expect(errors).toEqual([]);
    process.stdout.write(
      JSON.stringify({
        ok: true,
        packaged,
        screenshots: output,
        checks: [
          "Tab and Shift+Tab",
          "block indentation",
          "undo and redo",
          "Python autoindent",
          "Python syntax colors in both themes",
          "search, count, navigation and Escape",
          "search and scroll to matches outside the viewport in a large script",
          "draft persistence and exact applied source",
          "keyboard focus escape",
          "compact layout",
        ],
      }) + "\n",
    );
  } catch (error) {
    console.error({
      url: page.url(),
      body: (await page.locator("body").innerText()).slice(0, 2000),
    });
    await page.screenshot({ path: path.join(output, "failure.png") });
    throw error;
  } finally {
    await application.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
