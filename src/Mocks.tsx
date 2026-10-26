import { t, localizeMessage, useLocale, getLocale } from "./i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Copy,
  Plus,
  Save,
  Trash2,
  Download,
  FileCode2,
  FolderOpen,
  LoaderCircle,
  Play,
  RotateCcw,
  Square,
  Upload,
} from "lucide-react";
import { api } from "./store";
import { PaneSeparator, usePaneResize } from "./PaneResize";
import type { SavedScript, ScriptLibraryData } from "./types";
import demoRu from "../examples/basic/scenario.py?raw";
import demoEn from "../examples/basic/scenario.en.py?raw";
const ScriptEditor = lazy(() => import("./ScriptEditor"));

interface MockDocument {
  source: string;
  folder: string;
}
interface MockLog {
  time: number;
  module: string;
  stage: string;
  revision: number;
  method: string;
  path: string;
  status: number | null;
  blocked: boolean;
  source: string;
  line: number | null;
  transition?: { source: string; destination: string; line: number } | null;
  trigger_note?: string;
  messages?: string[];
  stopped?: boolean;
  state_changes?: Record<string, unknown>;
  error?: string;
  phase?: string;
}
interface MockStatus extends MockDocument {
  state: Record<string, unknown>;
  applied: boolean;
  session_key: string;
  sessions: number;
  name: string;
  stages: string[];
  stage: string;
  enabled: boolean;
  revision: number;
  logs: MockLog[];
  load_error: string;
}
const empty: MockDocument = {
  source: "",
  folder: "",
};
export default function Mocks({
  onEnabledChange,
  active = true,
}: {
  onEnabledChange: (enabled: boolean) => void;
  active?: boolean;
}) {
  useLocale();
  const demo = getLocale() === "ru" ? demoRu : demoEn;
  const [editorStarted, setEditorStarted] = useState(active);
  useEffect(() => {
    if (active) setEditorStarted(true);
  }, [active]);
  const workspaceSize = usePaneResize("scenarios-v1", {
    initial: 0.72,
    min: 360,
    otherMin: 220,
    ratio: true,
  });
  const [status, setStatus] = useState<MockStatus | null>(null);
  const [draft, setDraft] = useState<MockDocument>(empty);
  const [library, setLibrary] = useState<ScriptLibraryData | null>(null);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  const initializing = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onEnabledChange(status?.enabled || false);
  }, [status?.enabled, onEnabledChange]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const value = await api<MockStatus>("/mocks");
        if (!active) return;
        setStatus(value);
        if (!initialized.current && !initializing.current) {
          initializing.current = true;
          let collection = await window.chls.scriptLibrary();
          // Preserve the previous single script without executing or replacing it.
          if (!collection.items.length) {
            collection = await window.chls.saveScript({
              name: value.source
                ? value.name || t("Мой сценарий")
                : t("Пример · example.com"),
              source: value.source || demo,
              folder: value.folder,
            });
          }
          if (!active) return;
          initialized.current = true;
          setLibrary(collection);
          const item =
            collection.items.find((i) => i.id === collection.selected) ||
            collection.items[0];
          openItem(item);
        }
      } catch (e) {
        initializing.current = false;
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    const unsubscribe = window.chls.onEvents((events) => {
      if (events.some((e) => e.type === "mocks" || e.type === "resync"))
        void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const saved = library?.items.find((item) => item.id === selected);
  const unsaved =
    !!saved &&
    (saved.name !== name ||
      saved.source !== draft.source ||
      saved.folder !== draft.folder);
  function openItem(item: SavedScript) {
    setSelected(item.id);
    setName(item.name);
    setDraft({ source: item.source, folder: item.folder });
    setError("");
  }
  async function saveCurrent() {
    const collection = await window.chls.saveScript({
      id: selected,
      name,
      ...draft,
    });
    setLibrary(collection);
    setNotice(t("Сохранено в библиотеке. Работающий скрипт не изменён."));
  }
  function transition(task: () => Promise<void>) {
    if (unsaved) setPending(() => task);
    else void run(task);
  }
  async function createScript(
    source = demo,
    title = t("Новый сценарий"),
    folder = "",
  ) {
    const collection = await window.chls.saveScript({
      name: title,
      source,
      folder,
    });
    setLibrary(collection);
    openItem(collection.items.find((item) => item.id === collection.selected)!);
    setQuery("");
    setNotice(
      t(
        "Сценарий добавлен в библиотеку. Проверьте код и примените, когда будете готовы.",
      ),
    );
  }
  useEffect(() => {
    if (!active) return;
    const save = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (library && name.trim()) void run(saveCurrent);
      }
    };
    window.addEventListener("keydown", save, true);
    return () => window.removeEventListener("keydown", save, true);
  });
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (unsaved) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [unsaved]);
  useEffect(() => {
    if (!pending && !deleteOpen) return;
    const previous = window.document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ||
          [],
      );
      const first = buttons[0],
        last = buttons[buttons.length - 1];
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap, true);
    return () => {
      window.removeEventListener("keydown", trap, true);
      previous?.focus();
    };
  }, [pending, deleteOpen]);
  const document = draft;
  const dirty =
    !!status &&
    (draft.source !== status.source || draft.folder !== status.folder);
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function control(action: string, stage = "") {
    await run(async () => {
      setStatus(
        await api<MockStatus>("/mocks/control", "POST", {
          action,
          stage,
        }),
      );
    });
  }
  return (
    <section className="mocks-page">
      {(pending || deleteOpen) && (
        <div
          className="modal-backdrop"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setPending(null);
              setDeleteOpen(false);
            }
          }}
        >
          <div
            className="script-confirm"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="script-dialog-title"
          >
            <h2 id="script-dialog-title">
              {deleteOpen ? t("Удалить сценарий?") : t("Сохранить изменения?")}
            </h2>
            <p>
              {deleteOpen
                ? t(
                    "«{0}» будет удалён из библиотеки. Работающий скрипт продолжит выполняться.",
                    [name],
                  )
                : t("В сценарии «{0}» есть несохранённые изменения.", [name])}
            </p>
            <div>
              <button
                className="button"
                autoFocus
                disabled={busy}
                onClick={() => {
                  setPending(null);
                  setDeleteOpen(false);
                }}
              >
                {t("Отмена")}
              </button>
              {deleteOpen ? (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const collection =
                        await window.chls.deleteScript(selected);
                      setLibrary(collection);
                      setDeleteOpen(false);
                      if (collection.items.length)
                        openItem(
                          collection.items.find(
                            (i) => i.id === collection.selected,
                          ) || collection.items[0],
                        );
                      else await createScript(demo, t("Пример · example.com"));
                      setNotice(
                        t(
                          "Удалено из библиотеки. Работающий скрипт не изменён.",
                        ),
                      );
                    })
                  }
                >
                  {t("Удалить")}
                </button>
              ) : (
                <>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const next = pending!;
                        setPending(null);
                        await next();
                      })
                    }
                  >
                    {t("Не сохранять")}
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || !name.trim()}
                    onClick={() =>
                      run(async () => {
                        await saveCurrent();
                        const next = pending!;
                        setPending(null);
                        await next();
                      })
                    }
                  >
                    {t("Сохранить и продолжить")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="page-heading">
        <div>
          <h1>{t("Сценарии")}</h1>
          <p>
            {t("Python-скрипты · обработчики запросов, ответов и сценарии")}
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            disabled={busy || !status?.applied}
            onClick={() => control("reset")}
          >
            <RotateCcw size={14} />
            {t("Сбросить состояние")}
          </button>
          <button
            className={`button ${status?.enabled ? "recording" : "primary"}`}
            disabled={busy || !status?.applied}
            onClick={() => control(status?.enabled ? "disable" : "enable")}
          >
            {status?.enabled ? <Square size={12} /> : <Play size={13} />}{" "}
            {status?.enabled ? t("Выключить сценарий") : t("Включить сценарий")}
          </button>
        </div>
      </div>
      <div className="mock-stages">
        <div className="mock-state">
          <span className={`status-dot ${status?.enabled ? "live" : ""}`} />
          <strong>{status?.name || t("Сценарий не применён")}</strong>
          <span className="muted">
            {status?.enabled
              ? t("Активен{0}", [status.stage ? " · " + status.stage : ""])
              : t("Выключен")}
            {dirty && t(" · есть черновик")}
          </span>
        </div>
        {!!status?.stages.length && (
          <div className="mock-stage-buttons">
            {status.stages.map((stage) => (
              <button
                key={stage}
                className={`button ${status.stage === stage ? "selected" : ""}`}
                aria-pressed={status.stage === stage}
                disabled={busy || !library}
                onClick={() => control("stage", stage)}
              >
                {stage}
              </button>
            ))}
          </div>
        )}
        {status?.applied && (
          <details className="mock-help">
            <summary>
              {t("Переменные · ")}
              {status.session_key}
              {t(" · контекстов: ")}
              {status.sessions}
            </summary>
            <pre>{JSON.stringify(status.state, null, 2)}</pre>
          </details>
        )}
      </div>
      <div
        className="mock-workspace"
        ref={workspaceSize.containerRef}
        style={{
          gridTemplateColumns: `${workspaceSize.size}px 6px minmax(0, 1fr)`,
        }}
      >
        <div className="mock-editor-pane">
          <div
            className="script-library"
            aria-label={t("Библиотека сценариев")}
          >
            <div className="script-library-picker">
              <input
                aria-label={t("Поиск сценариев")}
                placeholder={t("Найти сценарий…")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                aria-label={t("Выбрать сценарий")}
                value={selected}
                disabled={busy || !library}
                onChange={(e) => {
                  const id = e.target.value;
                  transition(async () => {
                    const collection = await window.chls.selectScript(id);
                    setLibrary(collection);
                    openItem(collection.items.find((item) => item.id === id)!);
                  });
                }}
              >
                {library?.items
                  .filter(
                    (item) =>
                      item.id === selected ||
                      item.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
              <button
                className="button"
                disabled={busy || !library}
                onClick={() => transition(() => createScript())}
              >
                <Plus size={14} />
                {t("Новый")}
              </button>
            </div>
            <div className="script-library-actions">
              <input
                aria-label={t("Название сценария")}
                maxLength={100}
                value={name}
                disabled={busy || !library}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="muted script-save-state">
                {unsaved ? t("Не сохранён") : t("Сохранён")}
              </span>
              <button
                className="button"
                title={t("Сохранить в библиотеке (Ctrl+S)")}
                disabled={busy || !library || !name.trim()}
                onClick={() => run(saveCurrent)}
              >
                <Save size={14} />
                {t("Сохранить")}
              </button>
              <button
                className="button subtle"
                aria-label={t("Дублировать сценарий")}
                title={t("Дублировать сценарий")}
                disabled={busy || !library}
                onClick={() =>
                  transition(() =>
                    createScript(
                      draft.source,
                      name.slice(0, 92) + t(" · копия"),
                      draft.folder,
                    ),
                  )
                }
              >
                <Copy size={14} />
              </button>
              <button
                className="button subtle"
                aria-label={t("Удалить сценарий")}
                title={t("Удалить из библиотеки")}
                disabled={busy || !library}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <div className="mock-editor-toolbar">
            <strong>
              <FileCode2 size={15} />
              Python
            </strong>
            <div>
              <button
                className="button subtle"
                disabled={busy || !library}
                onClick={() =>
                  transition(() =>
                    createScript(demo, t("Пример · example.com")),
                  )
                }
              >
                {t("Пример")}
              </button>
              <button
                className="button subtle"
                disabled={busy || !library}
                onClick={() =>
                  transition(async () => {
                    const item = await window.chls.importMockScript();
                    if (item)
                      await createScript(
                        item.source,
                        item.name.slice(0, 100),
                        item.folder,
                      );
                  })
                }
              >
                <Upload size={13} />
                {t("Импорт")}
              </button>
              <button
                className="button subtle"
                disabled={busy || !library || !draft.source || !name.trim()}
                onClick={() =>
                  run(async () => {
                    await window.chls.saveText(
                      name.replace(/[<>:"/\\|?*]/g, "_") + ".py",
                      draft.source,
                    );
                  })
                }
              >
                <Download size={13} />
                {t("Экспорт .py")}
              </button>
            </div>
          </div>
          {/(^|\n)\s*модуль\s/.test(draft.source) && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await api<{ source: string }>(
                    "/mocks/convert",
                    "POST",
                    document,
                  );
                  setDraft((d) => ({ ...d, source: result.source }));
                  setNotice(
                    t(
                      "Переведено в Python. Проверьте ответы переходов: скрытого 200 и подавления повторов больше нет.",
                    ),
                  );
                })
              }
            >
              {t("Перевести в Python")}
            </button>
          )}
          <label className="mock-folder">
            <span>{t("Папка JSON")}</span>
            <div className="file-input">
              <input
                aria-label={t("Папка JSON")}
                placeholder={t("Для ответов из файлов")}
                value={draft.folder}
                disabled={busy || !library}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, folder: e.target.value }))
                }
              />
              <button
                className="button"
                aria-label={t("Выбрать папку JSON")}
                disabled={busy || !library}
                onClick={() =>
                  run(async () => {
                    const folder = await window.chls.chooseMockFolder();
                    if (folder) setDraft((d) => ({ ...d, folder }));
                  })
                }
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </label>
          <Suspense
            fallback={
              <div className="script-editor muted padded">
                {t("Загрузка редактора…")}
              </div>
            }
          >
            {editorStarted && library && (
              <ScriptEditor
                key={selected}
                readOnly={busy}
                value={draft.source}
                onChange={(source) => setDraft((d) => ({ ...d, source }))}
              />
            )}
            {editorStarted && !library && (
              <div className="script-editor muted padded" role="status">
                {t("Загрузка скрипта…")}
              </div>
            )}
          </Suspense>
          {(error || status?.load_error) && (
            <div className="inline-error" role="alert">
              {localizeMessage(error || status?.load_error || "")}
            </div>
          )}
          {notice && (
            <div className="mock-notice" role="status">
              {localizeMessage(notice)}
            </div>
          )}
          <div className="mock-apply">
            <span className="muted">
              {t("Применить этот скрипт: сохранить и сбросить состояние.")}
            </span>
            <button
              className="button"
              disabled={busy || !library || !draft.source || !name.trim()}
              onClick={() =>
                run(async () => {
                  const result = await api<{ stages: string[] }>(
                    "/mocks/validate",
                    "POST",
                    document,
                  );
                  setNotice(
                    t("Проверено: {0} этапов. Рабочий сценарий не изменён.", [
                      result.stages.length,
                    ]),
                  );
                })
              }
            >
              {t("Проверить")}
            </button>
            <button
              className="button primary"
              disabled={busy || !library || !draft.source || !name.trim()}
              onClick={() =>
                run(async () => {
                  const value = await api<MockStatus>(
                    "/mocks",
                    "PUT",
                    document,
                  );
                  setStatus(value);
                  setDraft({ source: value.source, folder: value.folder });
                  await saveCurrent();
                  setNotice(
                    t("Сценарий применён") +
                      (value.enabled
                        ? t(" и активен.")
                        : t(". Нажмите «Включить сценарий».")),
                  );
                })
              }
            >
              {busy && <LoaderCircle size={14} className="spin" />}
              {t("Применить сценарий")}
            </button>
          </div>
        </div>
        <PaneSeparator
          label={t("Ширина редактора сценария и журнала")}
          pane={workspaceSize}
        />
        <aside className="mock-log-pane">
          <div className="mock-editor-toolbar">
            <strong>
              {t("Срабатывания")}{" "}
              <span className="muted">{status?.logs.length || 0}/200</span>
            </strong>
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => control("clear")}
            >
              {t("Очистить")}
            </button>
          </div>
          <div className="mock-log-list">
            {status?.logs.length ? (
              status.logs.map((log, index) => (
                <div
                  className={`mock-log-entry ${log.blocked ? "blocked" : ""}`}
                  key={`${log.time}-${index}`}
                >
                  <div>
                    <strong>
                      {log.status || t("→ сервер")} {log.method}
                    </strong>
                    <time>
                      {new Date(log.time * 1000).toLocaleTimeString(
                        getLocale(),
                      )}
                    </time>
                  </div>
                  <code>{log.path}</code>
                  <span>
                    {log.stage || t("Скрипт")} · {log.phase} · v{log.revision}
                  </span>
                  <small>
                    {log.source}
                    {log.line ? t(" · строка {0}", [log.line]) : ""}
                  </small>
                  {log.transition && (
                    <strong className="mock-transition">
                      {log.transition.source} → {log.transition.destination}
                    </strong>
                  )}
                  {log.messages?.map((message, i) => (
                    <small key={i}>
                      {log.stopped && i === (log.messages?.length || 0) - 1
                        ? localizeMessage(message)
                        : message}
                    </small>
                  ))}
                  {!!Object.keys(log.state_changes || {}).length && (
                    <pre>{JSON.stringify(log.state_changes, null, 2)}</pre>
                  )}
                </div>
              ))
            ) : (
              <p className="mock-help">
                {t(
                  "Здесь появятся обработчики, ошибки, переходы и изменения состояния.",
                )}
              </p>
            )}
          </div>
          <details className="mock-help">
            <summary>{t("Как писать скрипты")}</summary>
            <p>
              {t(
                'Обычный Python: app = Script("Название"), @app.get("/path") и @app.post("/path"). Обработчик получает request и ctx. Верните response(200, json=...), response(200, file="order.json") или None для передачи в обычные правила и на сервер.',
              )}
            </p>
            <p>
              {t(
                'Область задаётся в коде: Script("Название", hosts=["api.example.com"], path_prefix="/driver/", unmatched="forward"). Без hosts и path_prefix подходят все домены и пути. unmatched="block" возвращает 501 для неизвестных запросов внутри области.',
              )}
            </p>
            <p>
              {t(
                'ctx.state — изменяемый словарь. app.session_key = lambda r: r.headers["X-Device-Id"] разделяет состояние по устройству. Без ключа состояние общее. Scenario добавляет состояния: @order.get("/path", state="created"), ctx.goto("completed"). Переходы всегда явные; повторный запрос выполняется снова.',
              )}
            </p>
            <p>
              {t(
                "ctx.stop() выключает весь скрипт после успешного обработчика. Текущий ответ отправляется, следующие запросы идут обычным путём. Состояние сохраняется; снова включить можно кнопкой.",
              )}
            </p>
            <pre>
              {
                'body = ctx.load_json("order.json")\nbody.set("time", 123)\nreturn response(200, json=body)'
              }
            </pre>
            <p>
              {t(
                "Короткое имя поля должно быть уникальным во всём JSON. Также доступны body.get(), body.remove(), точные пути order.start.time и JSON Pointer /order/start/time. body.data — обычный словарь или список Python.",
              )}
            </p>
            <p>
              {t(
                "@app.on_response получает request, response, ctx. Изменяйте response.json, response.text и response.headers. Для запросов доступны request.json, request.text, request.url и request.headers.",
              )}
            </p>
            <p>
              {t(
                "Файлы загружаются при проверке/применении. Для вычисляемых имён перечислите их в app.files. Скрипты выполняются в отдельном процессе: обработчик до 2 секунд, инициализация до 10 секунд.",
              )}
            </p>
            <p>
              {t(
                "Python имеет доступ к файлам и системе. Применяйте доверенные скрипты. Проверка тоже выполняет код верхнего уровня. После перезапуска скрипт выключен.",
              )}
            </p>
          </details>
        </aside>
      </div>
    </section>
  );
}
