import { useLayoutEffect, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { t, useLocale } from "./i18n";

export default function RequestUrl({ url }: { url: string }) {
  useLocale();
  const container = useRef<HTMLDivElement>(null);
  const measurement = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const queryStart = url.indexOf("?");
  const hasQuery = queryStart >= 0 && queryStart < url.length - 1;
  const collapsible = hasQuery && overflows;
  const collapsed = collapsible && !expanded;

  useLayoutEffect(() => {
    const element = container.current;
    const text = measurement.current;
    if (!element || !text) return;
    const measure = () => {
      setOverflows(
        text.getBoundingClientRect().width > element.clientWidth + 1,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(text);
    measure();
    return () => observer.disconnect();
  }, [url]);

  return (
    <div
      className={`full-url request-url ${collapsed ? "is-collapsed" : ""}`}
      ref={container}
    >
      <span
        className="request-url-measure"
        ref={measurement}
        aria-hidden="true"
      >
        {url}
      </span>
      <span className="request-url-value">
        {collapsed ? url.slice(0, queryStart + 1) : url}
      </span>
      {collapsible && (
        <button
          className="request-url-toggle"
          aria-expanded={expanded}
          aria-label={
            expanded ? t("Свернуть параметры URL") : t("Показать полный URL")
          }
          title={
            expanded ? t("Свернуть параметры URL") : t("Показать полный URL")
          }
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp size={13} /> : "…"}
        </button>
      )}
    </div>
  );
}
