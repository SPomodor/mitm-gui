import { useEffect, useRef, useState } from "react";
import {
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

interface MockDocument {
  source: string;
  folder: string;
  hosts: string[];
  scope: string;
  strict: boolean;
}
interface MockLog {
  time: number;
  module: string;
  stage: string;
  revision: number;
  method: string;
  path: string;
  status: number;
  blocked: boolean;
  source: string;
  line: number | null;
}
interface MockStatus extends MockDocument {
  name: string;
  stages: string[];
  stage: string;
  enabled: boolean;
  revision: number;
  logs: MockLog[];
  load_error: string;
}
const demo = `# Учебный пример, не ответы реального приложения.
модуль "Демо заказа"
начало "Собирается"
путь info = "/driver/demo/order"

общие:
  POST "/driver/demo/seen" -> 200 пусто

этап "Собирается":
  GET info -> 200 {"orderId":"demo-order","status":"assembling","mock":true}

этап "В магазин":
  GET info -> 200 {"orderId":"demo-order","status":"to_store","mock":true}

этап "В магазине":
  GET info -> 200 {"orderId":"demo-order","status":"at_store","mock":true}

этап "К клиенту":
  GET info -> 200 {"orderId":"demo-order","status":"to_customer","mock":true}

этап "Передать заказ":
  GET info -> 200 {"orderId":"demo-order","status":"at_customer","mock":true}

этап "Вернуться":
  GET info -> 200 {"orderId":"demo-order","status":"returning","mock":true}

этап "Завершён":
  GET info -> 200 {"orderId":"demo-order","status":"completed","mock":true}
`;
const empty: MockDocument = {
  source: "",
  folder: "",
  hosts: [],
  scope: "/driver/",
  strict: true,
};
export default function Mocks({
  onEnabledChange,
}: {
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [status, setStatus] = useState<MockStatus | null>(null);
  const [draft, setDraft] = useState<MockDocument>(empty);
  const [hostText, setHostText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
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
        if (!initialized.current) {
          initialized.current = true;
          setDraft({
            source: value.source,
            folder: value.folder,
            hosts: value.hosts,
            scope: value.scope,
            strict: value.strict,
          });
          setHostText(value.hosts.join(", "));
        }
      } catch (e) {
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
  const document = {
    ...draft,
    hosts: hostText
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
  const dirty =
    !!status &&
    JSON.stringify(document) !==
      JSON.stringify({
        source: status.source,
        folder: status.folder,
        hosts: status.hosts,
        scope: status.scope,
        strict: status.strict,
      });
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
        await api<MockStatus>("/mocks/control", "POST", { action, stage }),
      );
    });
  }
  return (
    <section className="mocks-page">
      <div className="page-heading">
        <div>
          <h1>
            Моки <span className="tag">Сценарии</span>
          </h1>
          <p>Общие ответы и этапы заказа · модуль включается отдельно</p>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            disabled={busy || !status?.stages.length}
            onClick={() => control("reset")}
          >
            <RotateCcw size={14} />
            Сбросить этап
          </button>
          <button
            className={`button ${status?.enabled ? "recording" : "primary"}`}
            disabled={busy || !status?.stages.length}
            onClick={() => control(status?.enabled ? "disable" : "enable")}
          >
            {status?.enabled ? <Square size={12} /> : <Play size={13} />}{" "}
            {status?.enabled ? "Выключить мок" : "Включить мок"}
          </button>
        </div>
      </div>
      <div className="mock-stages">
        <div className="mock-state">
          <span className={`status-dot ${status?.enabled ? "live" : ""}`} />
          <strong>{status?.name || "Сценарий не применён"}</strong>
          <span className="muted">
            {status?.enabled ? `Активен · ${status.stage}` : "Выключен"}
            {dirty && " · есть черновик"}
          </span>
        </div>
        {!!status?.stages.length && (
          <div className="mock-stage-buttons">
            {status.stages.map((stage) => (
              <button
                key={stage}
                className={`button ${status.stage === stage ? "selected" : ""}`}
                aria-pressed={status.stage === stage}
                disabled={busy}
                onClick={() => control("stage", stage)}
              >
                {stage}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mock-workspace">
        <div className="mock-editor-pane">
          <div className="mock-editor-toolbar">
            <strong>
              <FileCode2 size={15} />
              Сценарий
            </strong>
            <div>
              <button
                className="button subtle"
                disabled={busy}
                onClick={() => {
                  if (
                    draft.source &&
                    !confirm("Заменить текущий черновик учебным примером?")
                  )
                    return;
                  setDraft({ ...empty, source: demo });
                  setHostText("mock.chls.test");
                  setNotice(
                    "Демо: http://mock.chls.test/driver/demo/order через прокси CHLS. Это учебные ответы.",
                  );
                }}
              >
                Демо
              </button>
              <button
                className="button subtle"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (
                      draft.source &&
                      !confirm("Заменить черновик шаблоном заказа 187?")
                    )
                      return;
                    const source = await window.chls.mockOrderTemplate();
                    setDraft((d) => ({ ...d, source }));
                    setNotice(
                      "Шаблон 187: выберите папку, содержащую order/187, и укажите домены. Нужны ваши JSON; мок конфигов пока не включён.",
                    );
                  })
                }
              >
                Шаблон 187
              </button>
              <button
                className="button subtle"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const item = await window.chls.importMockScript();
                    if (item) {
                      setDraft((d) => ({ ...d, ...item }));
                      setNotice(
                        "Сценарий открыт в черновике. Укажите домен, проверьте и примените.",
                      );
                    }
                  })
                }
              >
                <Upload size={13} />
                Открыть
              </button>
              <button
                className="button subtle"
                disabled={busy || !draft.source}
                onClick={() =>
                  run(async () => {
                    await window.chls.saveText("scenario.chls", draft.source);
                  })
                }
              >
                <Download size={13} />
                Сохранить файл
              </button>
            </div>
          </div>
          <div className="mock-settings">
            <label>
              Домены через запятую
              <input
                aria-label="Домены мок-модуля"
                placeholder="api.example.com"
                value={hostText}
                onChange={(e) => setHostText(e.target.value)}
              />
            </label>
            <label>
              Папка JSON
              <div className="file-input">
                <input
                  aria-label="Папка JSON"
                  placeholder="Для ответов из файлов"
                  value={draft.folder}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, folder: e.target.value }))
                  }
                />
                <button
                  className="button"
                  aria-label="Выбрать папку JSON"
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
            <div className="mock-scope">
              <label>
                Префикс API
                <input
                  value={draft.scope}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, scope: e.target.value }))
                  }
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={draft.strict}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, strict: e.target.checked }))
                  }
                />
                Блокировать неизвестные запросы внутри префикса
              </label>
            </div>
          </div>
          <textarea
            className="mock-code"
            aria-label="Код сценария"
            spellCheck={false}
            placeholder={
              'модуль "Заказ"\n\nэтап "Собирается":\n  "/driver/order/info" -> 200 "order.json"'
            }
            value={draft.source}
            onChange={(e) =>
              setDraft((d) => ({ ...d, source: e.target.value }))
            }
          />
          {(error || status?.load_error) && (
            <div className="inline-error" role="alert">
              {error || status?.load_error}
            </div>
          )}
          {notice && (
            <div className="mock-notice" role="status">
              {notice}
            </div>
          )}
          <div className="mock-apply">
            <span className="muted">
              Применение возвращает начальный этап. Включение — отдельно.
            </span>
            <button
              className="button"
              disabled={busy || !draft.source}
              onClick={() =>
                run(async () => {
                  const result = await api<{ stages: string[] }>(
                    "/mocks/validate",
                    "POST",
                    document,
                  );
                  setNotice(
                    `Проверено: ${result.stages.length} этапов. Рабочий сценарий не изменён.`,
                  );
                })
              }
            >
              Проверить
            </button>
            <button
              className="button primary"
              disabled={busy || !draft.source}
              onClick={() =>
                run(async () => {
                  const value = await api<MockStatus>(
                    "/mocks",
                    "PUT",
                    document,
                  );
                  setStatus(value);
                  setDraft({ ...document, hosts: value.hosts });
                  setHostText(value.hosts.join(", "));
                  setNotice(
                    "Сценарий применён" +
                      (value.enabled
                        ? " и активен."
                        : ". Нажмите «Включить мок»."),
                  );
                })
              }
            >
              {busy && <LoaderCircle size={14} className="spin" />}Применить
              сценарий
            </button>
          </div>
        </div>
        <aside className="mock-log-pane">
          <div className="mock-editor-toolbar">
            <strong>
              Срабатывания{" "}
              <span className="muted">{status?.logs.length || 0}/200</span>
            </strong>
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => control("clear")}
            >
              Очистить
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
                      {log.status} {log.method}
                    </strong>
                    <time>
                      {new Date(log.time * 1000).toLocaleTimeString()}
                    </time>
                  </div>
                  <code>{log.path}</code>
                  <span>
                    {log.stage} · v{log.revision}
                  </span>
                  <small>
                    {log.source}
                    {log.line ? ` · строка ${log.line}` : ""}
                  </small>
                </div>
              ))
            ) : (
              <p className="mock-help">
                Здесь появятся ответы модуля и заблокированные запросы. После
                выбора этапа приложение должно снова запросить данные.
              </p>
            )}
          </div>
          <details className="mock-help">
            <summary>Как писать сценарий</summary>
            <p>
              «общие:» задаёт ответы для всех этапов. Ответ этапа заменяет общий
              для того же пути. HTTP-метод перед путём необязателен; без него
              подходят все методы. Query string не участвует в сопоставлении.
            </p>
            <pre>
              {
                'файлы "order/187"\nпуть info = "/driver/order/info"\n\nобщие:\n  POST "/driver/seen" -> 200 пусто\n\nэтап "Собирается":\n  GET info -> 200 "order.json"'
              }
            </pre>
            <p>
              JSON-файлы проверяются и загружаются при применении. После их
              изменения примените сценарий снова. Выключенный модуль не меняет
              трафик; мок-ответы имеют приоритет над обычными правилами. После
              перезапуска модуль выключен.
            </p>
          </details>
        </aside>
      </div>
    </section>
  );
}
