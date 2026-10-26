import { t, useLocale } from "./i18n";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import VirtualCode from "./VirtualCode";
import { formatBody } from "./formatBody";

export default memo(function SearchBody({
  rawText,
  format,
  truncated = false,
}: {
  rawText: string;
  format: boolean;
  truncated?: boolean;
}) {
  useLocale();
  const formatted = useMemo(
    () => formatBody(rawText, truncated),
    [rawText, truncated],
  );
  const text = format ? formatted : rawText;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
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
  // Focus after React mounts the input, even when rendering takes more than a frame.
  useLayoutEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open]);
  useEffect(() => {
    const find = () => {
      setOpen(true);
      // An already-open search does not trigger the mount effect again.
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("chls-find-body", find);
    return () => window.removeEventListener("chls-find-body", find);
  }, []);
  const move = (delta: number) =>
    setCurrent((value) =>
      matches.length ? (value + delta + matches.length) % matches.length : 0,
    );
  return (
    <div className="searchable-body">
      {open ? (
        <div
          className="body-search"
          role="search"
          aria-label={t("Поиск в теле")}
        >
          <Search size={14} />
          <input
            ref={input}
            aria-label={t("Найти в теле")}
            placeholder={t("Найти в JSON или тексте…")}
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
            aria-label={t("Предыдущее совпадение")}
            disabled={!matches.length}
            onClick={() => move(-1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            className="icon-button"
            aria-label={t("Следующее совпадение")}
            disabled={!matches.length}
            onClick={() => move(1)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            className="icon-button"
            aria-label={t("Закрыть поиск в теле")}
            onClick={() => setOpen(false)}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          className="body-find-button text-button"
          onClick={() => setOpen(true)}
        >
          <Search size={12} />
          {t(" Найти · Ctrl+F")}
        </button>
      )}
      <VirtualCode
        text={text}
        matches={open ? matches : undefined}
        queryLength={open ? query.length : 0}
        active={index}
      />
    </div>
  );
});
