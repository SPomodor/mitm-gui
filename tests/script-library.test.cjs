const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ScriptLibrary } = require("../electron/script-library.cjs");

test("library preserves independent code and folders across restarts, rename, copy and delete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chls-library-"));
  try {
    const file = path.join(dir, "scripts.json");
    const library = new ScriptLibrary(file);
    assert.equal(library.read().items.length, 0);
    const one = library.save({
      name: "One",
      source: "# incomplete Python is a valid saved draft",
      folder: "C:\\fixtures",
    }).items[0];
    const two = library.save({
      name: "Two",
      source: "print('text only')",
      folder: "",
    }).items[1];
    library.save({ ...one, name: "Renamed" });
    library.select(two.id);
    const restarted = new ScriptLibrary(file);
    assert.equal(restarted.read().selected, two.id);
    assert.equal(restarted.read().items[0].name, "Renamed");
    assert.equal(restarted.read().items[0].folder, "C:\\fixtures");
    assert.equal(restarted.read().items[1].source, two.source);
    const copied = restarted.save({
      name: "Copy",
      source: one.source,
      folder: one.folder,
    });
    assert.equal(copied.items.length, 3);
    assert.notEqual(copied.selected, one.id);
    restarted.remove(two.id);
    assert.equal(restarted.read().items.length, 2);
    assert.throws(() => restarted.save({ ...two }), /больше не существует/);
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => restarted.save({ name: " ", source: "", folder: "" }));
    assert.equal(fs.readFileSync(file, "utf8"), before);
    fs.writeFileSync(file, "broken");
    assert.throws(() =>
      restarted.save({ name: "New", source: "", folder: "" }),
    );
    assert.equal(fs.readFileSync(file, "utf8"), "broken");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
