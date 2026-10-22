import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";

export default function SearchBody({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const result: number[] = [];
    if (!query) return result;
    const haystack = text.toLowerCase(),
      needle = query.toLowerCase();
    let position = 0;
    while (result.length < 10000) {
      const found = haystack.indexOf(needle, position);
      if (found < 0) break;
      result.push(found);
      position = found + needle.length;
    }
    return result;
  }, [text, query]);
  const index = matches.length ? current % matches.length : 0;
  useEffect(() => {
    const find = () => {
      setOpen(true);
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.select();
      });
    };
    window.addEventListener("chls-find-body", find);
    return () => window.removeEventListener("chls-find-body", find);
  }, []);
  useEffect(() => {
    body.current
      ?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [index, query, text]);
  const move = (delta: number) =>
    setCurrent((value) =>
      matches.length ? (value + delta + matches.length) % matches.length : 0,
    );
  const pieces = useMemo(() => {
    if (!open || !matches.length) return text || "Пустое тело";
    let start = 0;
    const result: React.ReactNode[] = [];
    matches.forEach((offset, i) => {
      result.push(text.slice(start, offset));
      result.push(
        <mark
          key={offset}
          data-current={i === index}
          className={i === index ? "current" : ""}
        >
          {text.slice(offset, offset + query.length)}
        </mark>,
      );
      start = offset + query.length;
    });
    result.push(text.slice(start));
    return result;
  }, [text, open, matches, index, query]);
  return (
    <div className="searchable-body">
      {open ? (
        <div className="body-search" role="search" aria-label="Поиск в теле">
          <Search size={14} />
          <input
            ref={input}
            aria-label="Найти в теле"
            placeholder="Найти в JSON или тексте…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrent(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                move(e.shiftKey ? -1 : 1);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <span role="status">
            {matches.length ? index + 1 : 0}/{matches.length}
            {matches.length === 10000 ? "+" : ""}
          </span>
          <button
            className="icon-button"
            aria-label="Предыдущее совпадение"
            disabled={!matches.length}
            onClick={() => move(-1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Следующее совпадение"
            disabled={!matches.length}
            onClick={() => move(1)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Закрыть поиск в теле"
            onClick={() => setOpen(false)}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          className="body-find-button text-button"
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => input.current?.focus());
          }}
        >
          <Search size={12} /> Найти · Ctrl+F
        </button>
      )}
      {open && query ? (
        <div className="code-view searched-code" ref={body}>
          <pre>{pieces}</pre>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
