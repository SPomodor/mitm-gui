import { t, localizeMessage, useLocale } from "./i18n";
import { useEffect, useState } from "react";
import { RuleEditor } from "./App";
import { api, useApp } from "./store";
import type { Rule } from "./types";

const close = () => {
  void window.chls.closeRuleEditor();
};

export default function RuleWindow() {
  useLocale();
  const [rule, setRule] = useState<Rule | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const theme = () => {
      document.documentElement.dataset.theme =
        localStorage.getItem("chls-theme") || "system";
    };
    theme();
    window.addEventListener("storage", theme);
    const loadRules = async () => {
      const rules = await api<Rule[]>("/rules");
      if (active) useApp.setState({ rules });
    };
    Promise.all([window.chls.ruleEditorData(), loadRules()])
      .then(([item]) => {
        if (active) {
          setRule(item);
          document.title = `${item.name} — mitm gui`;
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const unsubscribe = window.chls.onEvents((events) => {
      if (events.some((event) => ["rules", "resync"].includes(event.type)))
        loadRules().catch((e) => {
          if (active) setError(e.message);
        });
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        document.querySelector<HTMLFormElement>(".rule-form")?.requestSubmit();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("storage", theme);
      window.removeEventListener("keydown", keydown);
    };
  }, []);
  if (error)
    return (
      <div className="inline-error" role="alert">
        {localizeMessage(error)}
      </div>
    );
  return rule ? (
    <RuleEditor rule={rule} onClose={close} />
  ) : (
    <div className="form-content">{t("Загрузка редактора…")}</div>
  );
}
