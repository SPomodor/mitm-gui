const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("chls", {
  openRuleEditor: (rule) => ipcRenderer.invoke("open-rule-editor", rule),
  ruleEditorData: () => ipcRenderer.invoke("rule-editor-data"),
  closeRuleEditor: () => ipcRenderer.invoke("close-rule-editor"),
  focusMain: () => ipcRenderer.invoke("focus-main"),
  api: (route, method, data) => ipcRenderer.invoke("api", route, method, data),
  chooseFile: () => ipcRenderer.invoke("choose-file"),
  saveText: (name, text) => ipcRenderer.invoke("save-text", name, text),
  download: (route, name) => ipcRenderer.invoke("download", route, name),
  exportSession: (id, name) => ipcRenderer.invoke("export-session", id, name),
  importRules: () => ipcRenderer.invoke("import-rules"),
  onEvents: (callback) => {
    const listener = (_, events) => callback(events);
    ipcRenderer.on("backend:events", listener);
    return () => ipcRenderer.removeListener("backend:events", listener);
  },
});
