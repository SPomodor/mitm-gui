const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Library saves text only. Compilation and activation belong to the engine.
class ScriptLibrary {
  constructor(file) {
    this.file = file;
  }
  read() {
    if (!fs.existsSync(this.file))
      return { version: 1, selected: "", items: [] };
    const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.items))
      throw new Error("Не удалось прочитать библиотеку сценариев");
    return data;
  }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    return data;
  }
  save(item) {
    if (
      !item ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 100 ||
      typeof item.source !== "string" ||
      item.source.length > 200000 ||
      typeof item.folder !== "string" ||
      item.folder.length > 4096
    )
      throw new Error("Проверьте название, код и папку сценария");
    const data = this.read();
    const index = data.items.findIndex((entry) => entry.id === item.id);
    if (item.id && index < 0) throw new Error("Сценарий больше не существует");
    if (index < 0 && data.items.length >= 500)
      throw new Error("В библиотеке уже 500 сценариев");
    const entry = {
      id: index < 0 ? randomUUID() : item.id,
      name: item.name.trim(),
      source: item.source,
      folder: item.folder,
      updatedAt: new Date().toISOString(),
    };
    if (index < 0) data.items.push(entry);
    else data.items[index] = entry;
    data.selected = entry.id;
    return this.write(data);
  }
  select(id) {
    const data = this.read();
    if (!data.items.some((item) => item.id === id))
      throw new Error("Сценарий не найден");
    data.selected = id;
    return this.write(data);
  }
  remove(id) {
    const data = this.read();
    data.items = data.items.filter((item) => item.id !== id);
    if (data.selected === id) data.selected = data.items[0]?.id || "";
    return this.write(data);
  }
}
module.exports = { ScriptLibrary };
