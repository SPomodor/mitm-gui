import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseSync } from "rolldown/utils";

const dictionary = JSON.parse(
  fs.readFileSync("electron/locales/en.json", "utf8"),
);
test("all literal UI translation keys exist and preserve interpolation parameters", () => {
  const files = fs
    .readdirSync("src")
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => "src/" + name);
  files.push("electron/main.cjs");
  for (const file of files) {
    const program = parseSync(file, fs.readFileSync(file, "utf8")).program;
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        ["t", "nativeT"].includes(node.callee?.name) &&
        node.arguments[0]?.type === "Literal"
      ) {
        assert.ok(
          dictionary[node.arguments[0].value],
          `${file}: missing ${node.arguments[0].value}`,
        );
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(walk);
        else if (child && typeof child === "object") walk(child);
      }
    }
    walk(program);
  }
  for (const [ru, en] of Object.entries(dictionary)) {
    assert.deepEqual(
      (en.match(/\{\d+\}/g) || []).sort(),
      (ru.match(/\{\d+\}/g) || []).sort(),
      ru,
    );
    assert.doesNotMatch(en, /[А-Яа-яЁё]/, ru);
  }
});
