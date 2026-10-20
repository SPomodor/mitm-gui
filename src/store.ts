import { create } from "zustand";
import type { Flow, Rule, Session, Status } from "./types";
interface State {
  status: Status | null;
  flows: Flow[];
  rules: Rule[];
  sessions: Session[];
  session: string;
  selected: string | null;
  error: string;
  ready: boolean;
  refresh: () => Promise<void>;
  loadFlows: (session?: string) => Promise<void>;
  setSelected: (id: string | null) => void;
  setError: (error: string) => void;
  saveRules: (rules: Rule[]) => Promise<void>;
  applyEvents: (events: Record<string, unknown>[]) => void;
}
export const api = <T>(route: string, method = "GET", data?: unknown) =>
  window.chls.api<T>(route, method, data);
export const useApp = create<State>((set, get) => ({
  status: null,
  flows: [],
  rules: [],
  sessions: [],
  session: "",
  selected: null,
  error: "",
  ready: false,
  setSelected: (selected) => set({ selected }),
  setError: (error) => set({ error }),
  refresh: async () => {
    const [status, rules, sessions] = await Promise.all([
      api<Status>("/status"),
      api<Rule[]>("/rules"),
      api<Session[]>("/sessions"),
    ]);
    const session = get().session || status.session;
    set({
      status,
      rules,
      sessions,
      session,
      ready: true,
      ...(!get().ready && status.errors.length
        ? { error: status.errors.join("; ") }
        : {}),
    });
    await get().loadFlows(session);
  },
  loadFlows: async (session = get().session) => {
    const flows = await api<Flow[]>(
      `/flows?session=${encodeURIComponent(session)}`,
    );
    if (get().session === session || !get().session) set({ flows, session });
  },
  saveRules: async (rules) => {
    const saved = await api<Rule[]>("/rules", "PUT", rules);
    set({ rules: saved });
  },
  applyEvents: (events) => {
    if (events.some((e) => e.type === "fatal")) {
      set({ error: String(events.find((e) => e.type === "fatal")?.message) });
      return;
    }
    if (
      events.some((e) => ["status", "rules", "resync"].includes(String(e.type)))
    )
      get()
        .refresh()
        .catch((e) => set({ error: e.message }));
    const incoming = events.filter(
      (e) => e.type === "flow" && e.session === get().session,
    ) as unknown as Flow[];
    if (incoming.length) {
      const map = new Map(get().flows.map((f) => [f.id, f]));
      incoming.forEach((f) => map.set(f.id, f));
      set({
        flows: [...map.values()]
          .sort((a, b) => b.started - a.started)
          .slice(0, 10000),
      });
    }
  },
}));
export const newRule = (kind: Rule["kind"] = "rewrite", flow?: Flow): Rule => ({
  id: crypto.randomUUID(),
  name:
    kind === "rewrite"
      ? "Новое Rewrite"
      : kind === "map_local"
        ? "Локальный ответ"
        : "Блокировка",
  enabled: true,
  kind,
  phase: kind === "rewrite" ? "response" : "request",
  host: flow?.original_host || flow?.host || "",
  path: flow?.original_path || flow?.path || "",
  method: flow?.original_method || flow?.method || "",
  match: flow ? "exact" : "contains",
  action: "header_modify",
  key: "",
  value: "",
  remove: false,
  status: kind === "block" ? 403 : 200,
  disconnect: false,
  file: "",
  content_type: "application/json",
});
