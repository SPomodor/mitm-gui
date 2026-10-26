import { t, useLocale } from "./i18n";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const ROW_HEIGHT = 23;
const EMPTY_MATCHES: number[] = [];
type Row = { start: number; end: number; line: number; continuation: boolean };

// Tokenization only sees bounded visible fragments, never a whole minified body.
const Syntax = memo(function Syntax({ text }: { text: string }) {
  return text
    .split(
      /("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|\b-?\d+(?:\.\d+)?\b)/g,
    )
    .map((part, i) => (
      <span
        key={i}
        className={
          part.endsWith(":")
            ? "token-key"
            : part.startsWith('"')
              ? "token-string"
              : /^(true|false|null|-?\d)/.test(part)
                ? "token-value"
                : ""
        }
      >
        {part}
      </span>
    ));
});

function highlighted(
  text: string,
  row: Row,
  matches: number[],
  queryLength: number,
  active: number,
) {
  let low = 0,
    high = matches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (matches[mid] + queryLength <= row.start) low = mid + 1;
    else high = mid;
  }
  const parts: React.ReactNode[] = [];
  let cursor = row.start;
  for (let i = low; i < matches.length && matches[i] < row.end; i++) {
    const start = Math.max(row.start, matches[i]),
      end = Math.min(row.end, matches[i] + queryLength);
    parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={i}
        data-current={i === active}
        className={i === active ? "current" : ""}
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  parts.push(text.slice(cursor, row.end));
  return parts;
}

export default memo(function VirtualCode({
  text,
  matches = EMPTY_MATCHES,
  queryLength = 0,
  active = 0,
}: {
  text: string;
  matches?: number[];
  queryLength?: number;
  active?: number;
}) {
  useLocale();
  const parent = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(120);
  useEffect(() => {
    const element = parent.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setColumns(
        Math.max(
          32,
          Math.min(512, Math.floor((entry.contentRect.width - 64) / 7.3)),
        ),
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rows = useMemo(() => {
    const result: Row[] = [];
    let start = 0,
      line = 1;
    while (start <= text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      let offset = start;
      do {
        result.push({
          start: offset,
          end: Math.min(offset + columns, end),
          line,
          continuation: offset !== start,
        });
        offset += columns;
      } while (offset < end);
      if (newline < 0) break;
      start = end + 1;
      line++;
    }
    return result;
  }, [text, columns]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const offset = matches[active];
  useEffect(() => {
    if (offset === undefined) return;
    let low = 0,
      high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (
        rows[mid].end < offset ||
        (rows[mid].end === offset && rows[mid].start !== offset)
      )
        low = mid + 1;
      else high = mid;
    }
    virtual.scrollToIndex(Math.min(low, rows.length - 1), { align: "center" });
  }, [offset, rows, virtual]);
  return (
    <div
      ref={parent}
      className={`code-view virtual-code ${queryLength ? "searched-code" : ""}`}
      aria-label={t("Содержимое тела")}
      tabIndex={0}
      data-total-rows={rows.length}
    >
      {text ? (
        <div
          className="virtual-code-content"
          style={{ height: virtual.getTotalSize() }}
        >
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <div
                className="code-line virtual-code-row"
                key={item.key}
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <span
                  className="line-number"
                  title={
                    row.continuation
                      ? t("Продолжение строки {0}", [row.line])
                      : undefined
                  }
                >
                  {row.continuation ? "↳" : row.line}
                </span>
                <code>
                  {queryLength ? (
                    highlighted(text, row, matches, queryLength, active)
                  ) : (
                    <Syntax text={text.slice(row.start, row.end)} />
                  )}
                </code>
              </div>
            );
          })}
        </div>
      ) : (
        <span className="muted padded">{t("Пустое тело")}</span>
      )}
    </div>
  );
});
