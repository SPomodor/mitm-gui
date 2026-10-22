import type { Rule } from "./types";

export function splitRuleLocation(
  path: string,
  match: Rule["match"],
  query?: string | null,
): Partial<Rule> {
  if (match === "regex") return { path, query };
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      return {
        host: url.hostname,
        path: url.pathname || "/",
        query: url.search.slice(1),
      };
    } catch {
      return { path, query };
    }
  }
  const separator = path.indexOf("?");
  return separator < 0
    ? { path, query: query ?? "" }
    : { path: path.slice(0, separator), query: path.slice(separator + 1) };
}
