import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(
  new URL("../src/formatBody.ts", import.meta.url),
  "utf8",
);
const { formatBody } = await import(
  "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(source)).toString("base64")
);

test("complete JSON uses standard Pretty", () => {
  assert.equal(
    formatBody('{"a":[1,{},[]],"b":true}'),
    '{\n  "a": [\n    1,\n    {},\n    []\n  ],\n  "b": true\n}',
  );
});
test("truncated JSON gets indentation without invented closing characters", () => {
  assert.equal(
    formatBody('{"items":[{"id":1},{"id":2,"name":"cut', true),
    '{\n  "items": [\n    {\n      "id": 1\n    },\n    {\n      "id": 2,\n      "name": "cut',
  );
});
test("punctuation, escapes and whitespace inside strings remain intact", () => {
  const value = JSON.stringify({
    text: 'a, b: { [ ] } " \\ \n end',
    nested: [{ x: 1 }, {}],
  });
  const prefix = value.slice(0, -2);
  const formatted = formatBody(prefix, true);
  assert.ok(formatted.includes(JSON.stringify('a, b: { [ ] } " \\ \n end')));
  assert.deepEqual(JSON.parse(formatted + "]}"), JSON.parse(value));
  assert.equal(
    formatBody('{"x":"escaped\\"unfinished\\', true),
    '{\n  "x": "escaped\\"unfinished\\',
  );
});
test("non-JSON and non-truncated malformed JSON stay unchanged", () => {
  for (const text of ["<html>{broken", "plain text", '{"a":'])
    assert.equal(formatBody(text), text);
  assert.equal(formatBody("<html>{broken", true), "<html>{broken");
});
test("depth and output expansion remain bounded", () => {
  const raw = "[".repeat(100000);
  assert.equal(formatBody(raw, true), raw);
});
