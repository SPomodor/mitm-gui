import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  Download,
  Ellipsis,
  FileJson,
  FilePlus2,
  FileText,
  Filter,
  FolderOpen,
  Globe,
  Layers,
  Link,
  LockKeyhole,
  LoaderCircle,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  Power,
  Circle,
  Settings2,
  ShieldBan,
  SlidersHorizontal,
  Smartphone,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { QRCodeSVG } from "qrcode.react";
import { api, newRule, useApp } from "./store";
import RewriteFields, { editableRule, requestActions } from "./RewriteFields";
import Mocks from "./Mocks";
import SearchBody from "./SearchBody";
import { PaneSeparator, usePaneResize } from "./PaneResize";
import { splitRuleLocation } from "./ruleLocation";
import packageInfo from "../package.json";
import type {
  Config,
  Detail,
  HttpDetail,
  ConnectionFlow,
  Flow,
  Message,
  Rule,
  Session,
  Status,
} from "./types";

const recordLocation = (flow: Flow) =>
  flow.kind === "http" ? flow.url : flow.endpoint;
const recordLabel = (flow: Flow) =>
  flow.kind === "http" ? flow.method : flow.protocol;
const recordStatus = (flow: Flow) =>
  flow.kind === "http" ? flow.status : null;
const kindLabel = {
  rewrite: "Rewrite",
  map_local: "Map Local",
  block: "Blocklist",
};
const iconFor = {
  rewrite: ArrowLeftRight,
  map_local: FolderOpen,
  block: ShieldBan,
};
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const time = (n: number) =>
  new Date(n * 1000).toLocaleTimeString("ru-RU", { hour12: false });
function IconButton({
  title,
  children,
  onClick,
  disabled = false,
}: {
  title: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Empty({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: typeof Activity;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={27} strokeWidth={1.35} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input,select,textarea,[tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h2>{title}</h2>
          <IconButton title="Закрыть" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const {
    status,
    ready,
    error,
    refresh,
    applyEvents,
    setError,
    rules,
    flows,
    sessions,
    session,
  } = useApp();
  const [page, setPage] = useState<"traffic" | "rules" | "mocks">("traffic");
  const sidebarSize = usePaneResize("sidebar-v1", {
    initial: 230,
    min: 200,
    otherMin: 660,
    max: 460,
  });
  const sidebarSections = usePaneResize("sidebar-sections-v1", {
    initial: 160,
    min: 120,
    otherMin: 110,
    axis: "y",
  });
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    text: string;
    action: () => Promise<void>;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const closeConfirmation = useMemo(() => () => setConfirmation(null), []);
  const [focusedHosts, setFocusedHosts] = useState<string[]>(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem("chls-focus-hosts") || "[]",
      );
      return Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [focusOnly, setFocusOnly] = useState(false);
  useEffect(() => {
    localStorage.setItem("chls-focus-hosts", JSON.stringify(focusedHosts));
  }, [focusedHosts]);
  function toggleHostFocus(value: string) {
    setFocusedHosts((items) =>
      items.includes(value)
        ? items.filter((h) => h !== value)
        : [...items, value],
    );
  }
  async function toggleSetting(route: string, enabled: boolean) {
    try {
      useApp.setState({
        status: await api<Status>(route, "POST", { enabled }),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const [mockEnabled, setMockEnabled] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportChoice, setExportChoice] = useState<Session | null>(null);
  const [exportConnections, setExportConnections] = useState(false);
  const closeRename = useMemo(() => () => setRenaming(null), []);
  async function exportSession(item: Session) {
    if (exporting) return;
    setExporting(item.id);
    try {
      const saved = await window.chls.exportSession(
        item.id,
        item.name,
        exportConnections ? "charles" : "http",
      );
      if (saved) setExportChoice(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(null);
    }
  }
  const [sslOpen, setSSLOpen] = useState(false);
  const [sslSeed, setSSLSeed] = useState<string | null>(null);
  const closeSSL = useMemo(() => () => setSSLOpen(false), []);
  const openSSL = (host: string | null = null) => {
    setSSLSeed(host);
    setSSLOpen(true);
  };
  const [connect, setConnect] = useState(false),
    [search, setSearch] = useState(""),
    [host, setHost] = useState(""),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("all");
  const [config, setConfig] = useState<Config>({
    http: true,
    wireguard: true,
    port: 8080,
    wg_port: 51820,
    lan: true,
    endpoint: "",
  });
  const [theme, setTheme] = useState(
    localStorage.getItem("chls-theme") || "system",
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const closeConnect = useMemo(() => () => setConnect(false), []);
  const openEditor = useCallback(
    (rule: Rule) => {
      window.chls.openRuleEditor(rule).catch((e) => setError(e.message));
    },
    [setError],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("chls-theme", theme);
  }, [theme]);
  useEffect(() => {
    let active = true;
    let attempts = 0;
    const init = async () => {
      try {
        await refresh();
      } catch (e) {
        if (active && ++attempts < 60) setTimeout(init, 500);
        else if (active) setError((e as Error).message);
      }
    };
    init();
    const unsub = window.chls?.onEvents(applyEvents);
    return () => {
      active = false;
      unsub?.();
    };
  }, [refresh, applyEvents, setError]);
  useEffect(() => {
    if (status) setConfig(status.config);
  }, [status?.config]);
  async function capture() {
    setBusy(true);
    try {
      const result = await api<Status>(
        status?.running ? "/capture/stop" : "/capture/start",
        "POST",
        status?.running ? undefined : config,
      );
      useApp.setState({ status: result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPage("traffic");
        searchRef.current?.focus();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        if (!busy) capture();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  const hosts = useMemo(
    () => [...new Set(flows.map((f) => f.host))].sort(),
    [flows],
  );
  const filtered = useMemo(
    () =>
      flows.filter(
        (f) =>
          (!host || f.host === host) &&
          (!focusOnly || focusedHosts.includes(f.host)) &&
          (!search ||
            `${recordLabel(f)} ${recordLocation(f)} ${recordStatus(f) || ""} ${f.client}`
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (filter === "all" ||
            (filter === "modified" &&
              f.kind === "http" &&
              f.rules.length > 0) ||
            (filter === "errors" &&
              (!!f.error || (recordStatus(f) || 0) >= 400))),
      ),
    [flows, host, search, filter, focusOnly, focusedHosts],
  );
  async function newSession() {
    try {
      const item = await api<Session>("/sessions", "POST");
      useApp.setState({ session: item.id, selected: null, flows: [] });
      setHost("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function openSession(id: string) {
    useApp.setState({ session: id, selected: null, flows: [] });
    setPage("traffic");
    setHost("");
    useApp
      .getState()
      .loadFlows(id)
      .catch((e) => setError(e.message));
  }
  const archivedSessions = sessions.filter((s) => s.archived);
  const viewingArchive = sessions.find((s) => s.id === session)?.archived;
  const renderSession = (s: Session) => {
    const SessionIcon = s.archived ? Archive : Layers;
    return (
      <div
        className={`session-row ${session === s.id ? "selected" : ""}`}
        key={s.id}
      >
        <button
          title={s.name}
          className={`session-item ${session === s.id ? "selected" : ""}`}
          onClick={() => openSession(s.id)}
        >
          <SessionIcon size={14} />
          <span>{s.name}</span>
          {status?.session === s.id && <span className="tiny-dot" />}
        </button>
        <IconButton
          title={`Переименовать: ${s.name}`}
          onClick={() => setRenaming(s)}
        >
          <Pencil size={13} />
        </IconButton>
        <IconButton
          title={`Удалить сессию: ${s.name}`}
          disabled={status?.session === s.id || !!exporting}
          onClick={() =>
            setConfirmation({
              title: "Удалить сессию?",
              text: `«${s.name}» и весь её трафик будут удалены.`,
              action: async () => {
                await api(`/sessions/${s.id}`, "DELETE");
                if (useApp.getState().session === s.id)
                  useApp.setState({
                    session: "",
                    selected: null,
                    flows: [],
                  });
                setHost("");
                await refresh();
              },
            })
          }
        >
          <Trash2 size={13} />
        </IconButton>
        <IconButton
          title={`Экспортировать HAR: ${s.name}`}
          disabled={!!exporting}
          onClick={() => {
            setExportConnections(false);
            setExportChoice(s);
          }}
        >
          {exporting === s.id ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <Download size={13} />
          )}
        </IconButton>
      </div>
    );
  };
  const activeRules = rules.filter((r) => r.enabled).length;
  return (
    <div className="app-shell" ref={sidebarSize.containerRef}>
      <aside className="sidebar" style={{ width: sidebarSize.size }}>
        <div className="brand drag">
          <span className="brand-mark">
            <Network size={18} />
          </span>
          <strong>
            chls<span className="brand-dot">.</span>
          </strong>
          <span className="version">v{packageInfo.version}</span>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          <button
            className={page === "traffic" ? "nav-item active" : "nav-item"}
            onClick={() => setPage("traffic")}
          >
            <Activity size={17} />
            Трафик<span className="count">{flows.length}</span>
          </button>
          <button
            className={page === "rules" ? "nav-item active" : "nav-item"}
            onClick={() => setPage("rules")}
          >
            <SlidersHorizontal size={17} />
            Правила<span className="count">{rules.length}</span>
          </button>
          <button
            className={page === "mocks" ? "nav-item active" : "nav-item"}
            onClick={() => setPage("mocks")}
          >
            <FileJson size={17} />
            Сценарии{mockEnabled && <span className="tag">ON</span>}
          </button>
          <button className="nav-item" onClick={() => setConnect(true)}>
            <Smartphone size={17} />
            Подключить устройство
          </button>
        </nav>
        <div className="sidebar-panes" ref={sidebarSections.containerRef}>
          <div
            className="sidebar-sessions"
            style={{
              flexBasis: page === "traffic" ? sidebarSections.size : undefined,
              flexGrow: page === "traffic" ? 0 : 1,
            }}
          >
            <div className="sidebar-section">
              <span>СЕССИИ</span>
              <IconButton title="Новая сессия" onClick={newSession}>
                <Plus size={14} />
              </IconButton>
            </div>
            <div className="session-list">
              {sessions.filter((s) => !s.archived).map(renderSession)}
            </div>
            <button
              className={`archive-toggle ${viewingArchive ? "is-viewing" : ""}`}
              aria-label="Архив сессий"
              aria-expanded={archiveOpen}
              aria-controls="archived-sessions"
              onClick={() => setArchiveOpen(!archiveOpen)}
            >
              <Archive size={14} />
              <span>Архив</span>
              <span className="archive-count">{archivedSessions.length}</span>
              {archiveOpen ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
            </button>
            {archiveOpen && (
              <div
                id="archived-sessions"
                className="session-list archive-session-list"
                aria-label="Архивные сессии"
              >
                {archivedSessions.map(renderSession)}
                {!archivedSessions.length && (
                  <p className="archive-empty">
                    Завершённые сессии появятся здесь.
                  </p>
                )}
              </div>
            )}
          </div>
          {page === "traffic" && (
            <>
              <PaneSeparator
                label="Высота разделов сессий и хостов"
                pane={sidebarSections}
              />
              <div className="sidebar-hosts">
                <div className="sidebar-section">
                  <span>ХОСТЫ</span>
                  <span className="muted">{hosts.length}</span>
                </div>
                <div
                  className="host-mode segmented"
                  role="group"
                  aria-label="Отображение хостов"
                >
                  <button
                    aria-pressed={!focusOnly}
                    className={!focusOnly ? "selected" : ""}
                    onClick={() => {
                      setFocusOnly(false);
                      setHost("");
                    }}
                  >
                    <Globe size={13} />
                    Все хосты
                  </button>
                  <button
                    aria-pressed={focusOnly}
                    className={focusOnly ? "selected" : ""}
                    onClick={() => {
                      setFocusOnly(true);
                      setHost("");
                    }}
                  >
                    <Filter size={13} />В фокусе
                    <span className="focus-count">{focusedHosts.length}</span>
                  </button>
                </div>
                <div className="host-list">
                  {[...new Set([...focusedHosts, ...hosts])]
                    .filter((h) => !focusOnly || focusedHosts.includes(h))
                    .map((h) => (
                      <div className="host-focus-row" key={h}>
                        <button
                          className={`host-item ${host === h ? "selected" : ""}`}
                          title={h}
                          onClick={() => setHost(h)}
                        >
                          <ChevronRight size={12} />
                          <span>{h}</span>
                        </button>
                        <button
                          className={`icon-button ${focusedHosts.includes(h) ? "accent" : ""}`}
                          aria-label={`Фокус: ${h}`}
                          aria-pressed={focusedHosts.includes(h)}
                          title="Добавить или убрать хост из фокуса"
                          onClick={() => toggleHostFocus(h)}
                        >
                          <Filter size={13} />
                        </button>
                      </div>
                    ))}
                  {focusOnly && !focusedHosts.length && (
                    <p className="padded muted">
                      Добавьте хост в фокус кнопкой рядом с его именем.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`capture-control ${status?.running ? "is-running" : ""}`}
            disabled={!ready || busy}
            onClick={capture}
            aria-label={status?.running ? "Остановить" : "Начать захват"}
            title={
              status?.running
                ? "Остановить перехват · Ctrl+Shift+R"
                : "Начать перехват · Ctrl+Shift+R"
            }
          >
            <span className="capture-control-icon">
              {busy || !ready ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Power size={16} />
              )}
            </span>
            <span className="capture-control-copy">
              <strong>Перехват</strong>
              <span>
                {!ready
                  ? "Запуск движка…"
                  : busy
                    ? "Переключение…"
                    : status?.running
                      ? "Активен"
                      : "Остановлен"}
              </span>
            </span>
            <span className={`status-dot ${status?.running ? "live" : ""}`} />
          </button>
          <div className="bottom-meta">
            <span>mitmproxy 12</span>
            <select
              aria-label="Тема оформления"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="system">Системная</option>
              <option value="dark">Тёмная</option>
              <option value="light">Светлая</option>
            </select>
          </div>
        </div>
      </aside>
      <PaneSeparator label="Ширина боковой панели" pane={sidebarSize} />
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {page === "traffic"
                ? "Трафик"
                : page === "rules"
                  ? "Правила"
                  : "Сценарии"}
            </strong>
          </div>
          <div className="toolbar-actions">
            <button
              className={`privacy-toggle ${status?.config.ssl_proxying !== false ? "enabled" : ""}`}
              disabled={!ready}
              aria-label={
                status?.config.ssl_proxying === false ? "SSL выкл" : "SSL вкл"
              }
              aria-pressed={status?.config.ssl_proxying !== false}
              title={
                status?.config.ssl_scope === "selected"
                  ? `SSL: только выбранные хосты (${status.config.ssl_hosts?.length || 0}). Изменения действуют на новые соединения.`
                  : "SSL: все хосты. Изменения действуют на новые соединения."
              }
              onClick={() =>
                toggleSetting(
                  "/capture/ssl",
                  status?.config.ssl_proxying === false,
                )
              }
            >
              {status?.config.ssl_proxying === false ? (
                <ShieldOff size={18} />
              ) : (
                <ShieldCheck size={18} />
              )}
            </button>
            <IconButton
              title="Настроить SSL"
              disabled={!ready}
              onClick={() => openSSL()}
            >
              <ChevronDown size={13} />
            </IconButton>
            <button
              className={`record-toggle ${status?.recording ? "is-recording" : ""}`}
              disabled={!ready}
              aria-label={
                status?.recording ? "Пауза записи" : "Включить запись"
              }
              aria-pressed={!!status?.recording}
              title="Сохранение трафика в сессию. Прокси, WireGuard и правила продолжают работать. Уже записываемые запросы получат ответ."
              onClick={() => toggleSetting("/recording", !status?.recording)}
            >
              {status?.recording ? (
                <Circle
                  className="record-dot"
                  size={11}
                  fill="currentColor"
                  strokeWidth={0}
                />
              ) : (
                <Pause size={15} />
              )}
              <span>{status?.recording ? "Запись" : "На паузе"}</span>
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <IconButton title="Скрыть ошибку" onClick={() => setError("")}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        {page === "traffic" ? (
          <>
            <div className="page-heading">
              <div>
                <h1>
                  Трафик{" "}
                  <span className="heading-count">{filtered.length}</span>
                </h1>
                <p>
                  {viewingArchive
                    ? `Архив · ${sessions.find((s) => s.id === session)?.name}`
                    : host || "Запросы и ответы ваших приложений"}
                </p>
              </div>
              <div className="heading-actions">
                {viewingArchive && status && (
                  <button
                    className="button subtle"
                    onClick={() => openSession(status.session)}
                  >
                    <Layers size={14} />К текущей сессии
                  </button>
                )}
                <IconButton
                  title="Очистить текущую сессию"
                  disabled={!flows.length}
                  onClick={() =>
                    setConfirmation({
                      title: "Очистить трафик?",
                      text: "Удалить все запросы выбранной сессии? Правила сохранятся.",
                      action: async () => {
                        await api(
                          `/flows?session=${encodeURIComponent(session)}`,
                          "DELETE",
                        );
                        useApp.setState({ selected: null, flows: [] });
                        await refresh();
                      },
                    })
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </div>
            <div className="filterbar">
              <div className="search-box">
                <Search size={15} />
                <input
                  ref={searchRef}
                  placeholder="Поиск по URL, методу, статусу или устройству…"
                  aria-label="Поиск трафика"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <IconButton
                    title="Сбросить поиск"
                    onClick={() => setSearch("")}
                  >
                    <X size={13} />
                  </IconButton>
                )}
              </div>
              <div className="segmented">
                {[
                  ["all", "Все"],
                  ["modified", "Изменённые"],
                  ["errors", "Ошибки"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={filter === value ? "selected" : ""}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <Traffic
              flows={filtered}
              onRule={openEditor}
              onConnect={() => setConnect(true)}
              archived={!!viewingArchive}
              onFocusHost={toggleHostFocus}
              focusedHosts={focusedHosts}
              onSSLHost={(host) => openSSL(host)}
            />
          </>
        ) : page === "rules" ? (
          <Rules onEdit={openEditor} />
        ) : null}
        <div
          className="mock-page-container"
          style={{ display: page === "mocks" ? "flex" : "none" }}
        >
          <Mocks onEnabledChange={setMockEnabled} />
        </div>
        <footer className="statusbar">
          <div>
            <span className={`status-dot ${status?.running ? "live" : ""}`} />
            {!ready
              ? "Подключение к движку"
              : status?.running
                ? status.recording
                  ? "Запись включена"
                  : "Запись на паузе"
                : "Ready"}
            <span className="footer-divider" />
            {status?.running
              ? status.servers
                  .filter((s) => s.is_running)
                  .map((s) =>
                    s.type === "regular"
                      ? `HTTP :${config.port}`
                      : `WireGuard :${config.wg_port}`,
                  )
                  .join(" · ")
              : "HTTP proxy + WireGuard"}
          </div>
          <div>
            {activeRules} правил активно
            {mockEnabled && (
              <span className="mock-active-label"> · Сценарий активен</span>
            )}
            <span className="footer-divider" />
            Local workspace
            <ShieldBan size={12} />
          </div>
        </footer>
      </main>
      {sslOpen && status && (
        <SSLSettings
          config={status.config}
          seedHost={sslSeed}
          onClose={closeSSL}
        />
      )}
      {connect && (
        <Connection
          config={config}
          setConfig={setConfig}
          onClose={closeConnect}
          onStart={capture}
          busy={busy}
        />
      )}
      {confirmation && (
        <Modal title={confirmation.title} onClose={closeConfirmation}>
          <div className="padded">
            <p>{confirmation.text}</p>
            <div className="dialog-actions">
              <button
                className="button"
                disabled={confirmBusy}
                onClick={closeConfirmation}
              >
                Отмена
              </button>
              <button
                className="button primary"
                disabled={confirmBusy}
                onClick={async () => {
                  setConfirmBusy(true);
                  try {
                    await confirmation.action();
                    setConfirmation(null);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setConfirmBusy(false);
                  }
                }}
              >
                {confirmBusy ? "Удаление…" : "Удалить"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {exportChoice && (
        <Modal
          title="Экспортировать HAR"
          onClose={() => {
            if (!exporting) setExportChoice(null);
          }}
        >
          <div className="padded">
            <p>По умолчанию HAR содержит только HTTP-запросы и ответы.</p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={exportConnections}
                disabled={!!exporting}
                onChange={(event) => setExportConnections(event.target.checked)}
              />
              Включить сводки соединений для Charles
            </label>
            {exportConnections && (
              <p className="muted">
                Зашифрованные соединения будут представлены условными записями
                CONNECT. Это сведения об адресах и объёме данных, без HTTP-путей
                и содержимого.
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                disabled={!!exporting}
                onClick={() => setExportChoice(null)}
              >
                Отмена
              </button>
              <button
                className="button primary"
                disabled={!!exporting}
                onClick={() => exportSession(exportChoice)}
              >
                {exporting ? "Экспорт…" : "Сохранить HAR"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {renaming && (
        <RenameSessionDialog item={renaming} onClose={closeRename} />
      )}
    </div>
  );
}

function SSLSettings({
  config,
  seedHost,
  onClose,
}: {
  config: Config;
  seedHost: string | null;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"all" | "selected">(
    seedHost ? "selected" : config.ssl_scope || "all",
  );
  const [hosts, setHosts] = useState(
    [
      ...new Set([
        ...(config.ssl_hosts || []),
        ...(seedHost ? [seedHost] : []),
      ]),
    ].join("\n"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title="Расшифровка SSL" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError("");
          try {
            const status = await api<Status>("/capture/ssl", "POST", {
              enabled:
                (useApp.getState().status?.config ?? config).ssl_proxying !==
                false,
              scope,
              hosts: hosts
                .split(/\r?\n/)
                .map((value) => value.trim())
                .filter(Boolean),
            });
            useApp.setState({ status });
            onClose();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="form-content">
          <div className="segmented" aria-label="Область SSL">
            <button
              type="button"
              className={scope === "all" ? "selected" : ""}
              aria-pressed={scope === "all"}
              onClick={() => setScope("all")}
            >
              Все хосты
            </button>
            <button
              type="button"
              className={scope === "selected" ? "selected" : ""}
              aria-pressed={scope === "selected"}
              onClick={() => setScope("selected")}
            >
              Только выбранные
            </button>
          </div>
          {scope === "selected" && (
            <label>
              Хосты для расшифровки
              <textarea
                rows={6}
                value={hosts}
                onChange={(event) => setHosts(event.target.value)}
                placeholder={"api.example.com\n*.example.net\nexample.org:8443"}
              />
            </label>
          )}
          <p className="field-hint">
            Один домен или IP на строку, порт необязателен. Маска *.example.com
            включает поддомены; корневой example.com добавляется отдельно.
            Пустой список выбранных хостов ничего не расшифровывает.
          </p>
          <p className="field-hint">
            Выбор по пути невозможен до расшифровки HTTPS. Остальные соединения
            проходят зашифрованными. Изменения действуют на новые соединения —
            переподключите клиент. Доверие сертификату CHLS по-прежнему
            требуется.
          </p>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить SSL"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function RenameSessionDialog({
  item,
  onClose,
}: {
  item: Session;
  onClose: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <Modal title="Переименовать сессию" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving || !name.trim()) return;
          setSaving(true);
          setError("");
          try {
            await api(`/sessions/${item.id}`, "PUT", { name: name.trim() });
            useApp.setState((state) => ({
              sessions: state.sessions.map((s) =>
                s.id === item.id ? { ...s, name: name.trim() } : s,
              ),
            }));
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="form-content">
          <label>
            Название сессии
            <input
              ref={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
          </label>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={saving || !name.trim()}
          >
            {saving && <LoaderCircle size={14} className="spin" />}Сохранить
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function Traffic({
  flows,
  onRule,
  onConnect,
  onFocusHost,
  onSSLHost,
  focusedHosts,
  archived = false,
}: {
  archived?: boolean;
  onFocusHost: (host: string) => void;
  onSSLHost: (host: string) => void;
  focusedHosts: string[];
  flows: Flow[];
  onRule: (rule: Rule) => void;
  onConnect: () => void;
}) {
  const { selected, setSelected, status } = useApp();
  const trafficSize = usePaneResize("traffic-v1", {
    initial: 0.6,
    min: 340,
    otherMin: 300,
    ratio: true,
  });
  const hasInspector = !!selected || flows.length > 0;
  const [detail, setDetail] = useState<Detail | null>(null),
    [loading, setLoading] = useState(false),
    [detailError, setDetailError] = useState("");
  const [context, setContext] = useState<{
    x: number;
    y: number;
    flow: Flow;
  } | null>(null);
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: flows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 37,
    overscan: 15,
  });
  const selectedFlow = flows.find((f) => f.id === selected);
  const revision = JSON.stringify(selectedFlow);
  useEffect(() => {
    let active = true;
    if (!selected) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setDetail((current) => (current?.id === selected ? current : null));
    setDetailError("");
    api<Detail>(`/flows/${selected}`)
      .then((d) => {
        if (active) setDetail(d);
      })
      .catch((e) => {
        if (active) setDetailError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected, revision]);
  useEffect(() => {
    if (!context) return;
    const close = () => setContext(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [context]);
  return (
    <div className="traffic-workspace" ref={trafficSize.containerRef}>
      <section
        className={`traffic-list ${selected ? "with-inspector" : ""}`}
        aria-label="Запросы"
        style={{ flex: hasInspector ? `0 0 ${trafficSize.size}px` : 1 }}
      >
        <div className="table-head traffic-row">
          <span>Тип</span>
          <span>Запрос</span>
          <span>Статус</span>
          <span>Время</span>
          <span>Размер</span>
        </div>
        <div
          ref={parent}
          className="table-scroll"
          role="listbox"
          aria-label="Перехваченные запросы"
          tabIndex={0}
          onKeyDown={(e) => {
            if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
            e.preventDefault();
            const index = flows.findIndex((f) => f.id === selected);
            const next = Math.max(
              0,
              Math.min(
                flows.length - 1,
                index + (e.key === "ArrowDown" ? 1 : -1),
              ),
            );
            if (flows[next]) {
              setSelected(flows[next].id);
              virtual.scrollToIndex(next);
            }
          }}
        >
          {flows.length ? (
            <div
              style={{ height: virtual.getTotalSize(), position: "relative" }}
            >
              {virtual.getVirtualItems().map((item) => {
                const flow = flows[item.index];
                return (
                  <div
                    key={flow.id}
                    role="option"
                    aria-selected={selected === flow.id}
                    className={`traffic-row flow-row ${selected === flow.id ? "selected" : ""}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: item.size,
                      transform: `translateY(${item.start}px)`,
                    }}
                    onClick={() => setSelected(flow.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(flow.id);
                      setContext({
                        x: Math.min(e.clientX, window.innerWidth - 220),
                        y: Math.min(e.clientY, window.innerHeight - 240),
                        flow,
                      });
                    }}
                  >
                    <span
                      className={`method ${recordLabel(flow) === "GET" ? "get" : ""}`}
                    >
                      {recordLabel(flow)}
                    </span>
                    <span className="url-cell" title={recordLocation(flow)}>
                      <span className="flow-host">{flow.host}</span>
                      <span className="flow-path">
                        {flow.kind === "connection"
                          ? `:${flow.port}`
                          : flow.path}
                      </span>
                      {flow.kind === "connection" && (
                        <span
                          className="encrypted-indicator"
                          role="img"
                          aria-label="Зашифрованное соединение"
                          title="Зашифрованное соединение — содержимое недоступно"
                        >
                          <LockKeyhole size={12} aria-hidden="true" />
                        </span>
                      )}
                      {flow.kind === "http" && flow.rules.length > 0 && (
                        <SlidersHorizontal
                          size={12}
                          className="rule-indicator"
                        />
                      )}
                    </span>
                    <span
                      className={`http-status ${flow.error || (recordStatus(flow) || 0) >= 400 ? "failure" : recordStatus(flow) ? "success" : ""}`}
                    >
                      {flow.error
                        ? "ERR"
                        : flow.kind === "connection"
                          ? flow.state === "open"
                            ? "…"
                            : "—"
                          : recordStatus(flow) || (
                              <span className="pending-dot" />
                            )}
                    </span>
                    <span className="numeric">
                      {flow.duration !== null ? `${flow.duration} ms` : "—"}
                    </span>
                    <span className="numeric">
                      {flow.size ? size(flow.size) : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty
              icon={archived ? Archive : Activity}
              title={
                useApp.getState().flows.length
                  ? "Запросы не найдены"
                  : archived
                    ? "В сессии нет запросов"
                    : status?.running
                      ? "Ожидаем первый запрос"
                      : "Ваш трафик начинается здесь"
              }
              action={
                !archived &&
                !useApp.getState().flows.length && (
                  <button className="button" onClick={onConnect}>
                    <Smartphone size={14} />
                    Подключить устройство
                  </button>
                )
              }
            >
              {useApp.getState().flows.length
                ? "Измените поиск или выбранные фильтры."
                : archived
                  ? "Сессия сохранена в архиве. Новые запросы записываются в текущую сессию."
                  : status?.running
                    ? "Откройте приложение на подключённом устройстве. Запросы появятся автоматически."
                    : "Подключите телефон или настройте браузер, чтобы просматривать и изменять запросы."}
            </Empty>
          )}
        </div>
        <div className="table-bottom">
          <span>{flows.length} записей</span>
          <span>Последние сверху</span>
        </div>
      </section>
      {hasInspector && (
        <PaneSeparator
          label="Ширина списка запросов и инспектора"
          pane={trafficSize}
        />
      )}
      {selected && (
        <section className="inspector" aria-label="Инспектор запроса">
          <div className="inspector-heading">
            <span>
              <FileText size={14} />
              Инспектор
            </span>
            <IconButton
              title="Закрыть инспектор"
              onClick={() => setSelected(null)}
            >
              <X size={15} />
            </IconButton>
          </div>
          {loading && !detail ? (
            <div className="loading">
              <LoaderCircle size={20} className="spin" />
            </div>
          ) : detail ? (
            detail.kind === "connection" ? (
              <EncryptedInspector detail={detail} />
            ) : (
              <MemoInspector detail={detail} onRule={onRule} />
            )
          ) : (
            <div className="inline-error">{detailError}</div>
          )}
        </section>
      )}
      {!selected && flows.length > 0 && (
        <section className="inspector inspector-placeholder">
          <Empty icon={FileText} title="Выберите запрос">
            Заголовки, содержимое и применённые правила появятся здесь.
          </Empty>
        </section>
      )}
      {context && (
        <div
          className="context-menu"
          style={{ left: context.x, top: context.y }}
        >
          {context.flow.kind === "http" &&
            (["rewrite", "map_local", "block"] as Rule["kind"][]).map(
              (kind) => {
                const Icon = iconFor[kind];
                return (
                  <button
                    key={kind}
                    onClick={() => {
                      if (context.flow.kind === "http")
                        onRule(newRule(kind, context.flow));
                    }}
                  >
                    <Icon size={14} />
                    Создать {kindLabel[kind]}
                  </button>
                );
              },
            )}
          <button onClick={() => onSSLHost(context.flow.host)}>
            <ShieldCheck size={14} />
            Расшифровывать SSL для хоста…
          </button>
          <button onClick={() => onFocusHost(context.flow.host)}>
            <Filter size={14} />
            {focusedHosts.includes(context.flow.host)
              ? "Убрать хост из фокуса"
              : "Добавить хост в фокус"}
          </button>
          <div className="menu-separator" />
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(recordLocation(context.flow))
                .catch((e) => useApp.getState().setError(e.message))
            }
          >
            <Copy size={14} />
            Копировать URL
          </button>
        </div>
      )}
    </div>
  );
}

function EncryptedInspector({ detail }: { detail: ConnectionFlow }) {
  return (
    <>
      <div className="request-summary">
        <div className="summary-line">
          <ShieldOff size={14} />
          <strong>Зашифровано · {detail.protocol}</strong>
          <span className="muted">
            {detail.state === "error"
              ? "Ошибка"
              : detail.state === "open"
                ? "Соединение открыто"
                : "Завершено"}
          </span>
        </div>
        <div className="full-url">{detail.endpoint}</div>
        <div className="request-meta">
          {time(detail.started)} · {detail.client}
        </div>
      </div>
      {detail.error && <div className="inline-error">{detail.error}</div>}
      <div className="encrypted-details">
        {[
          ["Отправлено", size(detail.bytes_sent || 0)],
          ["Получено", size(detail.bytes_received || 0)],
          ["Всего", size(detail.size)],
          [
            "Длительность",
            detail.duration !== null ? `${detail.duration} ms` : "В процессе",
          ],
          ["Транспорт", detail.transport?.toUpperCase() || "TCP"],
        ].map(([label, value]) => (
          <div className="encrypted-detail" key={label}>
            <span>{label}</span>
            <code>{value}</code>
          </div>
        ))}
      </div>
      <p className="padded muted">
        {detail.experimental && "UDP-захват — экспериментальная функция. "}
        {detail.ssl_reason === "not_selected"
          ? "Хост не выбран для расшифровки SSL. "
          : detail.ssl_reason === "disabled"
            ? "При открытии соединения SSL был выключен. "
            : "Расшифровка SSL к соединению не применялась. "}
        HTTP-запросы, заголовки и тела недоступны. Для просмотра содержимого
        включите SSL для нужного хоста и переподключите клиент.
      </p>
    </>
  );
}

function Inspector({
  detail,
  onRule,
}: {
  detail: HttpDetail;
  onRule: (rule: Rule) => void;
}) {
  const [side, setSide] = useState<"request" | "response">("response"),
    [tab, setTab] = useState("body"),
    [original, setOriginal] = useState(false),
    [format, setFormat] = useState(true),
    [menu, setMenu] = useState(false),
    [copied, setCopied] = useState(false);
  const key = original
    ? (`original_${side}` as "original_request" | "original_response")
    : side;
  const message = detail[key];
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setTab("body");
        setTimeout(() => window.dispatchEvent(new Event("chls-find-body")), 0);
      }
    };
    window.addEventListener("keydown", find);
    return () => window.removeEventListener("keydown", find);
  }, []);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      useApp.getState().setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="request-summary">
        <div className="summary-line">
          <span className={`method ${detail.method === "GET" ? "get" : ""}`}>
            {detail.method}
          </span>
          <span
            className={`http-status ${detail.error || (detail.status || 0) >= 400 ? "failure" : "success"}`}
          >
            {detail.error ? "Error" : detail.status || "Pending"}
          </span>
          <span className="numeric">
            {detail.duration !== null ? `${detail.duration} ms` : "В процессе"}
          </span>
          <div className="create-menu">
            <button className="button small" onClick={() => setMenu(!menu)}>
              <Plus size={12} />
              Правило
              <ChevronDown size={12} />
            </button>
            {menu && (
              <div className="dropdown">
                {(["rewrite", "map_local", "block"] as Rule["kind"][]).map(
                  (kind) => (
                    <button
                      key={kind}
                      onClick={() => {
                        setMenu(false);
                        onRule(newRule(kind, detail));
                      }}
                    >
                      {kindLabel[kind]}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
        <div className="full-url">{detail.url}</div>
        <div className="request-meta">
          {time(detail.started)}
          <span>·</span>
          {detail.client}
          <span>·</span>
          {size(detail.size)}
        </div>
      </div>
      {detail.error && <div className="inline-error">{detail.error}</div>}
      <div className="inspector-switch">
        <button
          className={side === "request" ? "selected" : ""}
          onClick={() => setSide("request")}
        >
          <ArrowUp size={13} />
          Request
        </button>
        <button
          className={side === "response" ? "selected" : ""}
          onClick={() => setSide("response")}
        >
          <ArrowDown size={13} />
          Response
        </button>
      </div>
      <div className="tabs">
        {[
          ["body", "Body"],
          ["headers", "Headers"],
          [
            "rules",
            `Правила${detail.rules.length ? ` · ${detail.rules.length}` : ""}`,
          ],
        ].map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "rules" ? (
        <div className="trace-list">
          {detail.rules.length ? (
            detail.rules.map((r, i) => (
              <div className="trace" key={`${r.id}-${i}`}>
                <div>
                  <span className={`trace-dot ${r.error ? "failed" : ""}`} />
                  <strong>{r.name}</strong>
                  <span className="tag">{r.phase}</span>
                </div>
                <p>
                  {r.error ||
                    (r.matched === false
                      ? "Совпадений в содержимом нет"
                      : `${kindLabel[r.kind as Rule["kind"]] || "Мок"} · Применено${r.matches !== undefined ? ` · Совпадений: ${r.matches}` : ""}`)}
                </p>
              </div>
            ))
          ) : (
            <p className="muted padded">
              К этому запросу правила не применялись.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="body-toolbar">
            <div className="segmented small">
              <button
                className={!original ? "selected" : ""}
                onClick={() => setOriginal(false)}
              >
                Итог
              </button>
              <button
                className={original ? "selected" : ""}
                onClick={() => setOriginal(true)}
              >
                Оригинал
              </button>
            </div>
            {side === "response" && message?.status && (
              <span
                className={`http-status ${message.status >= 400 ? "failure" : "success"}`}
                title="Статус выбранной версии ответа"
              >
                HTTP {message.status}
              </span>
            )}
            <div className="body-tools">
              {tab === "body" && (
                <button
                  className={`text-button ${format ? "accent" : ""}`}
                  onClick={() => setFormat(!format)}
                >
                  Pretty
                </button>
              )}
              <IconButton
                title="Копировать"
                disabled={!message}
                onClick={() =>
                  copy(
                    tab === "headers"
                      ? message!.headers
                          .map(([k, v]) => `${k}: ${v}`)
                          .join("\n")
                      : message!.text,
                  )
                }
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </IconButton>
              {tab === "body" && (
                <IconButton
                  title="Сохранить исходные байты тела"
                  disabled={!message?.body_file}
                  onClick={() =>
                    window.chls
                      .download(
                        `/flows/${detail.id}/body/${key}`,
                        `${side}.bin`,
                      )
                      .catch((e) => useApp.getState().setError(e.message))
                  }
                >
                  <Download size={13} />
                </IconButton>
              )}
            </div>
          </div>
          {!message ? (
            <div className="padded muted">
              {side === "response"
                ? "Ответ ещё не получен или соединение было прервано."
                : "Нет сохранённых данных."}
            </div>
          ) : tab === "headers" ? (
            <div className="headers-list">
              {message.headers.map(([name, value], i) => (
                <div className="header-entry" key={i}>
                  <span>{name}</span>
                  <code>{value}</code>
                </div>
              ))}
            </div>
          ) : (
            <>
              {message.streamed && (
                <div className="notice">
                  Тело передано потоком. Содержимое не сохранено; Rewrite body
                  недоступен.
                </div>
              )}
              {message.truncated && (
                <div className="notice">
                  Показаны первые 256 KB. Полное тело можно сохранить.
                </div>
              )}
              <SearchBody
                rawText={message.text}
                format={format}
                truncated={message.truncated}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
const MemoInspector = memo(Inspector);

function Rules({ onEdit }: { onEdit: (rule: Rule) => void }) {
  const { rules, saveRules, setError } = useApp();
  const [filter, setFilter] = useState("all"),
    [busy, setBusy] = useState(false);
  const visible = rules.filter((r) => filter === "all" || r.kind === filter);
  async function persist(next: Rule[]) {
    setBusy(true);
    try {
      await saveRules(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importRules() {
    try {
      const data = await window.chls.importRules();
      if (data === null) return;
      if (!Array.isArray(data)) throw new Error("Ожидается массив правил");
      await persist([
        ...rules,
        ...(data as Rule[]).map((r) => ({ ...r, id: crypto.randomUUID() })),
      ]);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function move(rule: Rule, delta: number) {
    const next = [...rules],
      index = next.findIndex((r) => r.id === rule.id),
      target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    persist(next);
  }
  return (
    <div className="rules-page">
      <div className="page-heading">
        <div>
          <h1>
            Правила <span className="heading-count">{rules.length}</span>
          </h1>
          <p>Управляйте тем, что отправляют и получают ваши приложения.</p>
        </div>
        <button className="button primary" onClick={() => onEdit(newRule())}>
          <Plus size={14} />
          Новое правило
        </button>
      </div>
      <div className="rules-toolbar">
        <div className="segmented">
          {[
            ["all", "Все"],
            ["rewrite", "Rewrite"],
            ["map_local", "Map Local"],
            ["block", "Blocklist"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "selected" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <button
            className="button subtle"
            disabled={busy}
            onClick={importRules}
          >
            <Upload size={14} />
            Импорт
          </button>
          <button
            className="button subtle"
            onClick={() =>
              window.chls
                .saveText("chls-rules.json", JSON.stringify(rules, null, 2))
                .catch((e) => setError(e.message))
            }
          >
            <Download size={14} />
            Экспорт
          </button>
        </div>
      </div>
      <div className="rule-table">
        <div className="rule-table-head">
          <span>Правило / условие</span>
          <span>Тип</span>
          <span>Состояние</span>
          <span />
        </div>
        {visible.length ? (
          visible.map((rule) => {
            const Icon = iconFor[rule.kind];
            const index = rules.indexOf(rule);
            return (
              <div className="rule-row" key={rule.id}>
                <button className="rule-main" onClick={() => onEdit(rule)}>
                  <span
                    className={`rule-icon ${rule.enabled ? "enabled" : ""}`}
                  >
                    <Icon size={17} />
                  </span>
                  <span>
                    <strong>{rule.name}</strong>
                    <small>
                      {rule.method && `${rule.method} `}
                      {rule.host || "Любой хост"}
                      {rule.path || " / *"}
                    </small>
                  </span>
                </button>
                <span className="tag">{kindLabel[rule.kind]}</span>
                <button
                  className={`toggle ${rule.enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={rule.enabled}
                  aria-label={`Включить ${rule.name}`}
                  disabled={busy}
                  onClick={() =>
                    persist(
                      rules.map((r) =>
                        r.id === rule.id ? { ...r, enabled: !r.enabled } : r,
                      ),
                    )
                  }
                >
                  <span />
                </button>
                <div className="rule-actions">
                  <IconButton
                    title="Выше"
                    disabled={busy || index === 0}
                    onClick={() => move(rule, -1)}
                  >
                    <ArrowUp size={13} />
                  </IconButton>
                  <IconButton
                    title="Ниже"
                    disabled={busy || index === rules.length - 1}
                    onClick={() => move(rule, 1)}
                  >
                    <ArrowDown size={13} />
                  </IconButton>
                  <IconButton
                    title="Дублировать"
                    disabled={busy}
                    onClick={() =>
                      persist([
                        ...rules,
                        {
                          ...rule,
                          id: crypto.randomUUID(),
                          name: `${rule.name} · копия`,
                        },
                      ])
                    }
                  >
                    <Copy size={13} />
                  </IconButton>
                  <IconButton
                    title="Удалить правило"
                    disabled={busy}
                    onClick={() =>
                      persist(rules.filter((r) => r.id !== rule.id))
                    }
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            );
          })
        ) : (
          <Empty
            icon={SlidersHorizontal}
            title="Поведение под вашим контролем"
            action={
              <div className="empty-actions">
                {(["rewrite", "map_local", "block"] as Rule["kind"][]).map(
                  (kind) => (
                    <button
                      className="button"
                      key={kind}
                      onClick={() => onEdit(newRule(kind))}
                    >
                      <Plus size={13} />
                      {kindLabel[kind]}
                    </button>
                  ),
                )}
              </div>
            }
          >
            Подменяйте ответы локальными файлами, изменяйте содержимое и
            блокируйте запросы.
          </Empty>
        )}
      </div>
      <div className="rules-note">
        <BookOpen size={14} />
        <span>
          Правила выполняются сверху вниз. Blocklist и Map Local завершают
          обработку запроса; затем применяются Rewrite ответа.
        </span>
      </div>
    </div>
  );
}

export function RuleEditor({
  rule,
  onClose,
}: {
  rule: Rule;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() =>
      editableRule({
        ...rule,
        ...splitRuleLocation(rule.path, rule.match, rule.query),
      }),
    ),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const set = <K extends keyof Rule>(key: K, value: Rule[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const queryInput = useRef<HTMLInputElement>(null);
  const { rules } = useApp();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api("/rules/save", "POST", draft);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="rule-editor-window">
      <header>
        <h1>
          {rules.some((r) => r.id === draft.id)
            ? "Редактировать правило"
            : "Новое правило"}
        </h1>
        <button
          className="button"
          type="button"
          onClick={() => window.chls.focusMain()}
        >
          <Activity size={14} />К запросам
        </button>
      </header>
      <form onSubmit={submit} className="rule-form">
        <div className="form-content">
          <label>
            Название
            <input
              required
              maxLength={200}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              autoFocus
            />
          </label>
          <div className="form-grid">
            <label>
              Тип
              <select
                value={draft.kind}
                onChange={(e) => set("kind", e.target.value as Rule["kind"])}
              >
                <option value="rewrite">Rewrite</option>
                <option value="map_local">Map Local</option>
                <option value="block">Blocklist</option>
              </select>
            </label>
            {draft.kind === "rewrite" && (
              <label>
                Стадия
                <select
                  value={draft.phase}
                  onChange={(e) =>
                    set("phase", e.target.value as Rule["phase"])
                  }
                >
                  <option value="request" disabled={draft.action === "status"}>
                    Запрос
                  </option>
                  <option
                    value="response"
                    disabled={requestActions.has(draft.action)}
                  >
                    Ответ
                  </option>
                  <option
                    value="both"
                    disabled={
                      requestActions.has(draft.action) ||
                      draft.action === "status"
                    }
                  >
                    Запрос и ответ
                  </option>
                </select>
              </label>
            )}
          </div>
          <div className="form-divider">УСЛОВИЯ</div>
          <div className="form-grid host-method">
            <label>
              Хост
              <input
                placeholder="api.example.com или *.example.com"
                value={draft.host}
                onChange={(e) => set("host", e.target.value)}
              />
            </label>
            <label>
              Метод
              <select
                value={draft.method}
                onChange={(e) => set("method", e.target.value)}
              >
                {[
                  "",
                  "GET",
                  "POST",
                  "PUT",
                  "PATCH",
                  "DELETE",
                  "HEAD",
                  "OPTIONS",
                ].map((m) => (
                  <option key={m} value={m}>
                    {m || "Любой"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-grid path-match">
            <label>
              Путь
              <input
                placeholder="/api/config"
                value={draft.path}
                onChange={(e) => {
                  const value = e.target.value;
                  setDraft((d) => ({
                    ...d,
                    ...splitRuleLocation(value, d.match, d.query),
                  }));
                  if (draft.match !== "regex" && value.endsWith("?"))
                    queryInput.current?.focus();
                }}
              />
            </label>
            <label>
              Сопоставление
              <select
                value={draft.match}
                onChange={(e) => set("match", e.target.value as Rule["match"])}
              >
                <option value="exact">Точное</option>
                <option value="contains">Содержит</option>
                <option value="regex">Regex</option>
              </select>
            </label>
          </div>
          <label>
            Query string
            <input
              placeholder="encrypted_request=1&deviceid=…"
              ref={queryInput}
              value={draft.query ?? ""}
              onChange={(e) => set("query", e.target.value.replace(/^\?/, ""))}
            />
          </label>
          <p className="field-hint">
            Параметры без «?». Пустое поле — любые параметры. Сопоставление
            применяется отдельно к пути и query string. Полный URL можно
            вставить в поле пути.
          </p>
          <p className="field-hint">
            Пустой хост — любой. Для любого пути выберите «Содержит» и оставьте
            путь пустым.
          </p>
          <div className="form-divider">ДЕЙСТВИЕ</div>
          {draft.kind === "block" ? (
            <>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={draft.disconnect}
                  onChange={(e) => set("disconnect", e.target.checked)}
                />
                Оборвать соединение без ответа
              </label>
              {!draft.disconnect && (
                <label>
                  HTTP-статус
                  <input
                    type="number"
                    min={100}
                    max={599}
                    required
                    value={draft.status}
                    onChange={(e) => set("status", Number(e.target.value))}
                  />
                </label>
              )}
            </>
          ) : draft.kind === "map_local" ? (
            <>
              <label>
                Локальный файл
                <div className="file-input">
                  <input
                    required
                    value={draft.file}
                    onChange={(e) => set("file", e.target.value)}
                    placeholder="Выберите файл на компьютере"
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={async () => {
                      try {
                        const file = await window.chls.chooseFile();
                        if (file) set("file", file);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <FolderOpen size={15} />
                  </button>
                </div>
              </label>
              <div className="form-grid">
                <label>
                  Content-Type
                  <input
                    required
                    value={draft.content_type}
                    onChange={(e) => set("content_type", e.target.value)}
                  />
                </label>
                <label>
                  HTTP-статус
                  <input
                    type="number"
                    required
                    min={100}
                    max={599}
                    value={draft.status}
                    onChange={(e) => set("status", Number(e.target.value))}
                  />
                </label>
              </div>
              <p className="field-hint">
                Файл читается при каждом запросе. Максимум 8 MB.
              </p>
            </>
          ) : (
            <RewriteFields
              draft={draft}
              onChange={(updates) => setDraft((d) => ({ ...d, ...updates }))}
            />
          )}
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving && <LoaderCircle size={14} className="spin" />}Сохранить
            правило
          </button>
        </footer>
      </form>
    </section>
  );
}

function Connection({
  config,
  setConfig,
  onClose,
  onStart,
  busy,
}: {
  config: Config;
  setConfig: (c: Config) => void;
  onClose: () => void;
  onStart: () => void;
  busy: boolean;
}) {
  const { status, setError } = useApp();
  const [device, setDevice] = useState<"android" | "iphone">(
    localStorage.getItem("chls-device") === "iphone" ? "iphone" : "android",
  );
  const [addressCopied, setAddressCopied] = useState(false);
  const [tab, setTab] = useState<"wireguard" | "http">("wireguard"),
    [wg, setWg] = useState(""),
    [loading, setLoading] = useState(false),
    [wgError, setWgError] = useState("");
  const [endpoint, setEndpoint] = useState(
    config.endpoint ||
      status?.addresses.find((ip) => !ip.startsWith("127.")) ||
      "127.0.0.1",
  );
  const wgRunning = status?.servers.some(
    (s) => s.type === "wireguard" && s.is_running,
  );
  const httpRunning = status?.servers.some(
    (s) => s.type === "regular" && s.is_running,
  );
  async function loadProfile() {
    setLoading(true);
    setWgError("");
    try {
      const result = await api<{ config: string }>(
        `/wireguard?endpoint=${encodeURIComponent(endpoint)}`,
      );
      setWg(result.config);
    } catch (e) {
      setWgError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (wgRunning) {
      loadProfile();
    } else setWg("");
  }, [wgRunning]);
  const clients = [...new Set(useApp((s) => s.flows).map((f) => f.client))];
  return (
    <Modal title="Подключить устройство" onClose={onClose} wide>
      <div className="connection-layout">
        <div className="connection-main">
          <div className="connection-intro">
            <span className="connection-symbol">
              <Smartphone size={22} />
            </span>
            <div>
              <h3>Подключение телефона</h3>
              <p>Выберите устройство и способ подключения.</p>
            </div>
          </div>
          <div className="connection-tabs segmented">
            <button
              className={tab === "wireguard" ? "selected" : ""}
              onClick={() => setTab("wireguard")}
            >
              <Network size={14} />
              WireGuard
            </button>
            <button
              className={tab === "http" ? "selected" : ""}
              onClick={() => setTab("http")}
            >
              <Globe size={14} />
              HTTP-прокси
            </button>
          </div>
          <div className="certificate-callout">
            <div className="certificate-callout-main">
              <div className="certificate-callout-heading">
                <Download size={16} />
                <strong>Сертификат для HTTPS</strong>
              </div>
              <button
                className="certificate-address"
                title="Копировать адрес"
                aria-label="Копировать адрес mitm.it"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText("http://mitm.it");
                    setAddressCopied(true);
                    setTimeout(() => setAddressCopied(false), 1800);
                  } catch (error) {
                    setError((error as Error).message);
                  }
                }}
              >
                <span>mitm.it</span>
                {addressCopied ? <Check size={16} /> : <Copy size={16} />}
                <small>{addressCopied ? "Скопировано" : "Копировать"}</small>
              </button>
            </div>
            <div className="certificate-callout-footer">
              <span>
                Откройте на телефоне, подключённом через WireGuard или прокси.
              </span>
              <button
                className="button small"
                onClick={() =>
                  window.chls
                    .download("/certificate", "chls-ca.cer")
                    .catch((e) => setError(e.message))
                }
              >
                <Download size={13} />
                Сохранить CA
              </button>
            </div>
          </div>
          {tab === "wireguard" ? (
            <>
              <div className="step">
                <span>1</span>
                <div>
                  <h4>Запустите WireGuard</h4>
                  <p>
                    Включите WireGuard в настройках справа и начните захват.
                  </p>
                </div>
              </div>
              <div className="step">
                <span>2</span>
                <div>
                  <h4>Добавьте туннель на телефоне</h4>
                  <p>
                    {device === "android"
                      ? "В приложении WireGuard нажмите «+» → «Сканировать QR-код», отсканируйте код ниже и задайте имя туннеля."
                      : "В приложении WireGuard нажмите «+» → «Создать из QR-кода», отсканируйте код ниже и разрешите добавление VPN-конфигурации."}{" "}
                    Компьютер должен быть доступен по указанному адресу.
                  </p>
                </div>
              </div>
              {wgRunning ? (
                <>
                  <div className="endpoint-control">
                    <label>
                      Адрес компьютера
                      <input
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                        placeholder="192.168.1.10"
                      />
                    </label>
                    <button
                      className="button"
                      disabled={loading}
                      onClick={loadProfile}
                    >
                      Обновить QR
                    </button>
                  </div>
                  {wgError && <div className="inline-error">{wgError}</div>}
                  {wg && (
                    <div className="qr-section">
                      <div className="qr">
                        <QRCodeSVG
                          value={wg}
                          size={184}
                          level="M"
                          marginSize={2}
                        />
                      </div>
                      <div>
                        <span className="tag">UDP · {config.wg_port}</span>
                        <p>
                          Профиль для одного устройства.
                          <br />
                          Не используйте его одновременно на нескольких
                          телефонах.
                        </p>
                        <button
                          className="button small"
                          onClick={() =>
                            window.chls
                              .saveText("chls.conf", wg)
                              .catch((e) => setError(e.message))
                          }
                        >
                          <Download size={13} />
                          Сохранить .conf
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="setup-placeholder">
                  <Network size={21} />
                  <span>QR-код появится после запуска WireGuard</span>
                </div>
              )}
              <div className="step">
                <span>3</span>
                <div>
                  <h4>Включите туннель и проверьте HTTPS</h4>
                  <p>
                    Включите переключатель рядом с туннелем в WireGuard. IPv4
                    направляется в туннель. IPv6 в этой версии не захватывается
                    и может идти напрямую. Другой VPN может конфликтовать с
                    подключением.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="step">
                <span>1</span>
                <div>
                  <h4>Подключитесь к одной сети</h4>
                  <p>
                    Телефон и компьютер должны видеть друг друга в локальной
                    сети.
                  </p>
                </div>
              </div>
              <div className="step">
                <span>2</span>
                <div>
                  <h4>Укажите прокси в настройках Wi-Fi</h4>
                  <p>
                    {device === "android"
                      ? "Настройки → Wi-Fi / Интернет → текущая сеть → Изменить (значок карандаша) → Дополнительные настройки → Прокси → Вручную. Введите сервер и порт, затем сохраните."
                      : "Настройки → Wi-Fi → ⓘ рядом с текущей сетью → Настройка прокси → Вручную. Введите сервер и порт, затем нажмите «Сохранить». Аутентификацию оставьте выключенной."}
                  </p>
                  {device === "android" && (
                    <p className="platform-hint">
                      Названия пунктов зависят от производителя. При
                      необходимости найдите «Прокси» в настройках Wi-Fi.
                    </p>
                  )}
                  <div className="proxy-values">
                    <div>
                      <small>Сервер</small>
                      <code>{endpoint}</code>
                    </div>
                    <div>
                      <small>Порт</small>
                      <code>{config.port}</code>
                    </div>
                  </div>
                </div>
              </div>
              <div className="step">
                <span>3</span>
                <div>
                  <h4>Откройте mitm.it в браузере телефона</h4>
                  <p>
                    {httpRunning
                      ? "Прокси запущен."
                      : "Сначала включите HTTP-прокси и запустите захват."}{" "}
                    Скачайте сертификат для вашей системы.
                  </p>
                </div>
              </div>
            </>
          )}
          <div className="certificate-instructions">
            <div className="certificate-instructions-heading">
              <h4>Установка сертификата</h4>
              <div className="device-selector">
                <div className="segmented" role="group" aria-label="Устройство">
                  {(
                    [
                      ["android", "Android"],
                      ["iphone", "iPhone"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={device === value}
                      className={device === value ? "selected" : ""}
                      onClick={() => {
                        setDevice(value);
                        localStorage.setItem("chls-device", value);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <ol>
              {device === "android" ? (
                <>
                  <li>
                    <strong>Скачайте сертификат.</strong> Откройте mitm.it в
                    браузере подключённого телефона и выберите Android.
                  </li>
                  <li>
                    <strong>Откройте настройки сертификатов.</strong> Настройки
                    → Безопасность и конфиденциальность → Дополнительные
                    настройки безопасности → Шифрование и учётные данные →
                    Установить сертификат → Сертификат ЦС.
                  </li>
                  <li>
                    <strong>Выберите скачанный файл.</strong> Подтвердите
                    установку и разблокировку устройства. Если пункты называются
                    иначе, найдите «Сертификат ЦС» в поиске настроек.
                  </li>
                  <li>
                    <strong>Разрешите доверие в debug-сборке.</strong>{" "}
                    Приложение должно доверять пользовательскому CA через
                    Network Security Config; отдельный pinning также требует
                    debug-настройки.
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <strong>Скачайте профиль.</strong> Откройте mitm.it в
                    Safari, выберите iOS и нажмите «Разрешить» для загрузки
                    профиля.
                  </li>
                  <li>
                    <strong>Установите профиль.</strong> Настройки → Основные →
                    VPN и управление устройством → профиль mitmproxy →
                    Установить. Введите код-пароль и подтвердите установку.
                    Также можно открыть пункт «Профиль загружен» на главном
                    экране настроек.
                  </li>
                  <li>
                    <strong>Включите полное доверие.</strong> Настройки →
                    Основные → Об этом устройстве → Доверие сертификатам →
                    включите доверие для mitmproxy и подтвердите.
                  </li>
                  <li>
                    <strong>Проверьте своё приложение.</strong> Откройте экран,
                    который отправляет запросы. При собственном pinning
                    настройте его debug-поведение для работы с прокси.
                  </li>
                </>
              )}
            </ol>
          </div>
        </div>
        <aside className="connection-settings">
          <div className="settings-caption">НАСТРОЙКИ ЗАХВАТА</div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={status?.running}
              checked={config.http}
              onChange={(e) => setConfig({ ...config, http: e.target.checked })}
            />
            HTTP-прокси
          </label>
          <label>
            TCP-порт
            <input
              type="number"
              min={1024}
              max={65535}
              disabled={status?.running}
              value={config.port}
              onChange={(e) =>
                setConfig({ ...config, port: Number(e.target.value) })
              }
            />
          </label>
          <div className="settings-separator" />
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={status?.running}
              checked={config.wireguard}
              onChange={(e) =>
                setConfig({ ...config, wireguard: e.target.checked })
              }
            />
            WireGuard
          </label>
          <label>
            UDP-порт
            <input
              type="number"
              min={1024}
              max={65535}
              disabled={status?.running}
              value={config.wg_port}
              onChange={(e) =>
                setConfig({ ...config, wg_port: Number(e.target.value) })
              }
            />
          </label>
          <div className="settings-separator" />
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={status?.running}
              checked={config.lan}
              onChange={(e) => setConfig({ ...config, lan: e.target.checked })}
            />
            Доступ из локальной сети
          </label>
          <p className="field-hint">
            Для телефона включите доступ из сети. Если подключения нет,
            проверьте брандмауэр Windows: TCP {config.port} и UDP{" "}
            {config.wg_port}.
          </p>
          <button
            className={`button full ${status?.running ? "" : "primary"}`}
            disabled={busy || !status}
            onClick={onStart}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : status?.running ? (
              <Square size={12} />
            ) : (
              <Play size={12} />
            )}{" "}
            {status?.running ? "Остановить" : "Начать захват"}
          </button>
          <div className="connection-checks">
            <div>
              <span
                className={`status-dot ${wgRunning || httpRunning ? "live" : ""}`}
              />
              Слушатель {wgRunning || httpRunning ? "запущен" : "остановлен"}
            </div>
            <div>
              <span className={`status-dot ${clients.length ? "live" : ""}`} />
              Клиентов в сессии: {clients.length}
            </div>
            <p>
              Работу туннеля проверяйте в WireGuard. Наличие HTTPS-запроса в
              списке подтверждает расшифровку.
            </p>
          </div>
        </aside>
      </div>
    </Modal>
  );
}
