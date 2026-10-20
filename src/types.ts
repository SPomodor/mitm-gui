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
export interface Flow {
  id: string;
  session: string;
  started: number;
  method: string;
  url: string;
  host: string;
  path: string;
  original_host?: string;
  original_path?: string;
  original_method?: string;
  status: number | null;
  duration: number | null;
  size: number;
  client: string;
  error: string | null;
  rules: Trace[];
  state: string;
}
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
export interface Detail extends Flow {
  request: Message;
  response: Message | null;
  original_request: Message | null;
  original_response: Message | null;
}
export interface Config {
  http: boolean;
  wireguard: boolean;
  port: number;
  wg_port: number;
  lan: boolean;
  endpoint: string;
}
export interface Status {
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
}
export interface BackendEvent {
  type: string;
  message?: string;
  [key: string]: unknown;
}
declare global {
  interface Window {
    chls: {
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
      mockOrderTemplate: () => Promise<string>;
      importMockScript: () => Promise<{
        source: string;
        folder: string;
      } | null>;
      saveText: (name: string, text: string) => Promise<boolean>;
      download: (route: string, name: string) => Promise<boolean>;
      exportSession: (id: string, name: string) => Promise<boolean>;
      importRules: () => Promise<unknown>;
      onEvents: (callback: (events: BackendEvent[]) => void) => () => void;
    };
  }
}
