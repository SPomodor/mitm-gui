const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("chls", {
  openRuleEditor: (rule) => ipcRenderer.invoke("open-rule-editor", rule),
  ruleEditorData: () => ipcRenderer.invoke("rule-editor-data"),
  closeRuleEditor: () => ipcRenderer.invoke("close-rule-editor"),
  focusMain: () => ipcRenderer.invoke("focus-main"),
  api: (route, method, data) => ipcRenderer.invoke("api", route, method, data),
  chooseFile: () => ipcRenderer.invoke("choose-file"),
  chooseMockFolder: () => ipcRenderer.invoke("choose-mock-folder"),
  mockOrderTemplate: () => ipcRenderer.invoke("mock-order-template"),
  importMockScript: () => ipcRenderer.invoke("import-mock-script"),
  saveText: (name, text) => ipcRenderer.invoke("save-text", name, text),
  download: (route, name) => ipcRenderer.invoke("download", route, name),
  exportSession: (id, name, format = "http") =>
    ipcRenderer.invoke("export-session", id, name, format),
  importRules: () => ipcRenderer.invoke("import-rules"),
  onEvents: (callback) => {
    const listener = (_, events) => callback(events);
    ipcRenderer.on("backend:events", listener);
    return () => ipcRenderer.removeListener("backend:events", listener);
  },
});
