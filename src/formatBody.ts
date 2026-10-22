// Format a JSON prefix without inventing missing values or closing brackets.
export function formatBody(raw: string, truncated = false): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    if (!truncated || !/^[\s\uFEFF]*[\[{]/.test(raw)) return raw;
  }

  const output: string[] = [];
  let depth = 0,
    quoted = false,
    escaped = false,
    newline = false,
    previous = "",
    length = 0;
  function append(value: string) {
    if (newline) {
      const indent = "\n" + "  ".repeat(Math.min(depth, 40));
      output.push(indent);
      length += indent.length;
      newline = false;
    }
    output.push(value);
    length += value.length;
  }
  for (const char of raw) {
    if (quoted) {
      append(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        quoted = false;
        previous = '"';
      }
    } else if (/\s|\uFEFF/.test(char)) {
      continue;
    } else if (char === '"') {
      append(char);
      quoted = true;
    } else if (char === "{" || char === "[") {
      append(char);
      depth++;
      newline = true;
      previous = char;
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      newline = previous !== (char === "}" ? "{" : "[");
      append(char);
      previous = char;
    } else if (char === ",") {
      append(char);
      newline = true;
      previous = char;
    } else if (char === ":") {
      append(": ");
      previous = char;
    } else {
      append(char);
      previous = char;
    }
    // Keep deeply nested/malformed previews from expanding without a bound.
    if (length > 2 * 1024 * 1024) return raw;
  }
  return output.join("");
}
