export interface RewriteOptions {
  search_name: string;
  search_value: string;
  replacement_name: string;
  replacement_value: string | null;
  regex: boolean;
  whole_value: boolean;
  case_sensitive: boolean;
  replace_all: boolean;
}
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  kind: "block" | "map_local" | "rewrite";
  phase: "request" | "response" | "both";
  host: string;
  path: string;
  query?: string | null;
  method: string;
  match: "contains" | "exact" | "regex";
  action:
    | "header"
    | "body"
    | "json"
    | "url"
    | "host"
    | "path"
    | "status"
    | "header_add"
    | "header_modify"
    | "header_remove"
    | "query_add"
    | "query_modify"
    | "query_remove";
  rewrite?: RewriteOptions | null;
  key: string;
  value: string;
  remove: boolean;
  status: number;
  disconnect: boolean;
  file: string;
  content_type: string;
}
export interface Trace {
  id: string;
  name: string;
  kind: string;
  phase: string;
  error?: string;
  matched?: boolean;
  matches?: number;
}
export interface RecordBase {
  id: string;
  session: string;
  started: number;
  host: string;
  duration: number | null;
  size: number;
  client: string;
  error: string | null;
  state: string;
}
export interface HttpFlow extends RecordBase {
  kind: "http";
  method: string;
  url: string;
  path: string;
  original_host?: string;
  original_path?: string;
  original_method?: string;
  status: number | null;
  rules: Trace[];
}
export interface ConnectionFlow extends RecordBase {
  kind: "connection";
  state: "open" | "closed" | "error";
  protocol: string;
  endpoint: string;
  port: number;
  transport: string;
  bytes_sent: number;
  bytes_received: number;
  experimental?: boolean;
  ssl_reason?: "disabled" | "not_selected";
}
export type Flow = HttpFlow | ConnectionFlow;
export interface Message {
  headers: [string, string][];
  size: number;
  streamed: boolean;
  http_version: string;
  url?: string;
  method?: string;
  status?: number;
  text: string;
  truncated: boolean;
  body_file: string | null;
}
export interface HttpDetail extends HttpFlow {
  request: Message | null;
  response: Message | null;
  original_request: Message | null;
  original_response: Message | null;
}
export type Detail = HttpDetail | ConnectionFlow;
export interface Config {
  ssl_proxying?: boolean;
  ssl_scope?: "all" | "selected";
  ssl_hosts?: string[];
  http: boolean;
  wireguard: boolean;
  port: number;
  wg_port: number;
  lan: boolean;
  endpoint: string;
}
export interface Status {
  recording: boolean;
  running: boolean;
  servers: {
    type: string;
    is_running: boolean;
    last_exception: string | null;
  }[];
  config: Config;
  session: string;
  errors: string[];
  addresses: string[];
  max_body_mb: number;
}
export interface Session {
  id: string;
  name: string;
  created: number;
  archived: boolean;
}
export interface BackendEvent {
  type: string;
  message?: string;
  [key: string]: unknown;
}
export interface SavedScript {
  id: string;
  name: string;
  source: string;
  folder: string;
  updatedAt: string;
}
export interface ScriptLibraryData {
  version: number;
  selected: string;
  items: SavedScript[];
}
declare global {
  interface Window {
    chls: {
      language: { preference: "auto" | "ru" | "en"; systemLocale: string };
      setLanguage: (preference: "auto" | "ru" | "en") => Promise<void>;
      onLanguage: (
        callback: (preference: "auto" | "ru" | "en") => void,
      ) => () => void;
      openRuleEditor: (rule: Rule) => Promise<void>;
      ruleEditorData: () => Promise<Rule>;
      closeRuleEditor: () => Promise<void>;
      focusMain: () => Promise<void>;
      api: <T = unknown>(
        route: string,
        method?: string,
        data?: unknown,
      ) => Promise<T>;
      chooseFile: () => Promise<string | null>;
      chooseMockFolder: () => Promise<string | null>;
      scriptLibrary: () => Promise<ScriptLibraryData>;
      saveScript: (
        item: Omit<SavedScript, "id" | "updatedAt"> & { id?: string },
      ) => Promise<ScriptLibraryData>;
      selectScript: (id: string) => Promise<ScriptLibraryData>;
      deleteScript: (id: string) => Promise<ScriptLibraryData>;
      importMockScript: () => Promise<{
        name: string;
        source: string;
        folder: string;
      } | null>;
      saveText: (name: string, text: string) => Promise<boolean>;
      download: (route: string, name: string) => Promise<boolean>;
      exportSession: (
        id: string,
        name: string,
        format?: "http" | "charles",
      ) => Promise<boolean>;
      importRules: () => Promise<unknown>;
      onEvents: (callback: (events: BackendEvent[]) => void) => () => void;
    };
  }
}
