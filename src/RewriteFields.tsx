import type { Rule, RewriteOptions } from "./types";

export const requestActions = new Set<Rule["action"]>([
  "host",
  "path",
  "url",
  "query_add",
  "query_modify",
  "query_remove",
]);
export function rewriteDefaults(action: Rule["action"]): RewriteOptions {
  return {
    search_name: "",
    search_value: "",
    replacement_name: "",
    replacement_value: null,
    regex: false,
    whole_value: action === "status",
    case_sensitive:
      !action.startsWith("header_") && !action.startsWith("query_"),
    replace_all: true,
  };
}
export function editableRule(rule: Rule): Rule {
  if (!rule.rewrite && ["body", "url"].includes(rule.action))
    return {
      ...rule,
      rewrite: {
        ...rewriteDefaults(rule.action),
        search_value: rule.action === "body" ? rule.key : "",
        replacement_value: rule.value,
      },
    };
  return rule;
}
const actions: [Rule["action"], string][] = [
  ["header", "Set Header · Установить заголовок"],
  ["header_add", "Add Header · Добавить заголовок"],
  ["header_modify", "Modify Header · Изменить заголовок"],
  ["header_remove", "Remove Header · Удалить заголовок"],
  ["host", "Host · Сервер"],
  ["path", "Path · Путь"],
  ["url", "URL"],
  ["query_add", "Add Query Param"],
  ["query_modify", "Modify Query Param"],
  ["query_remove", "Remove Query Param"],
  ["status", "Response Status"],
  ["body", "Body · Содержимое"],
  ["json", "Поле JSON"],
];

export default function RewriteFields({
  draft,
  onChange,
}: {
  draft: Rule;
  onChange: (updates: Partial<Rule>) => void;
}) {
  const opts = draft.rewrite || rewriteDefaults(draft.action);
  const patch = (update: Partial<RewriteOptions>) =>
    onChange({ rewrite: { ...opts, ...update } });
  const add = draft.action.endsWith("_add"),
    remove = draft.action.endsWith("_remove");
  const fields =
    draft.action.startsWith("header_") || draft.action.startsWith("query_");
  const body = draft.action === "body";
  function changeAction(action: Rule["action"]) {
    onChange({
      action,
      rewrite:
        action === "header" || action === "json"
          ? null
          : rewriteDefaults(action),
      phase: requestActions.has(action)
        ? "request"
        : action === "status"
          ? "response"
          : draft.phase,
      remove: false,
    });
  }
  return (
    <>
      <label>
        Что изменить
        <select
          value={draft.action}
          onChange={(e) => changeAction(e.target.value as Rule["action"])}
        >
          {actions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {draft.action === "header" || draft.action === "json" ? (
        <>
          <label>
            {draft.action === "json"
              ? "Имя поля или точный путь JSON"
              : "Имя заголовка"}
            <input
              required
              value={draft.key}
              onChange={(e) => onChange({ key: e.target.value })}
              placeholder={
                draft.action === "json"
                  ? "time или order.start.time"
                  : "X-Debug"
              }
            />
          </label>
          {draft.action === "json" && (
            <p className="field-hint">
              Короткое имя ищется во всём JSON, включая массивы. Если совпадений
              несколько, правило покажет ошибку с точными путями. Для ключей с
              точками используйте JSON Pointer: /order/start/time.
            </p>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.remove}
              onChange={(e) => onChange({ remove: e.target.checked })}
            />
            Удалить {draft.action === "json" ? "поле" : "заголовок"}
          </label>
          {!draft.remove && (
            <label>
              {draft.action === "json"
                ? "Новое значение JSON"
                : "Новое значение"}
              <textarea
                rows={3}
                value={draft.value}
                onChange={(e) => onChange({ value: e.target.value })}
                placeholder={
                  draft.action === "json"
                    ? 'true, 42, "текст" или {"key": "value"}'
                    : ""
                }
              />
            </label>
          )}
          {draft.action === "header" && (
            <p className="field-hint">
              Устанавливает значение, даже если заголовка ещё нет. Для поиска по
              значению или переименования выберите Modify Header.
            </p>
          )}
        </>
      ) : (
        <>
          {!add && (
            <section className="rewrite-section">
              <h3>Поиск</h3>
              {fields && (
                <label>
                  Имя для поиска
                  <input
                    value={opts.search_name}
                    onChange={(e) => patch({ search_name: e.target.value })}
                    placeholder={
                      draft.action.startsWith("header_")
                        ? "Content-Type или X-(.*)"
                        : "Имя query-параметра"
                    }
                  />
                </label>
              )}
              <label>
                Значение для поиска
                {body ? (
                  <textarea
                    rows={3}
                    value={opts.search_value}
                    onChange={(e) => patch({ search_value: e.target.value })}
                    placeholder="Текст или регулярное выражение"
                  />
                ) : (
                  <input
                    value={opts.search_value}
                    onChange={(e) => patch({ search_value: e.target.value })}
                    placeholder={
                      draft.action === "status"
                        ? "200"
                        : "Пусто — любое значение"
                    }
                  />
                )}
              </label>
              <div className="rewrite-options">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={opts.regex}
                    onChange={(e) => patch({ regex: e.target.checked })}
                  />
                  Regex
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={opts.whole_value}
                    onChange={(e) => patch({ whole_value: e.target.checked })}
                  />
                  Значение целиком
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={opts.case_sensitive}
                    onChange={(e) =>
                      patch({ case_sensitive: e.target.checked })
                    }
                  />
                  Учитывать регистр
                </label>
              </div>
              <p className="field-hint">
                Пустые поля поиска соответствуют любому значению.
                {fields ? " Имя сравнивается без учёта регистра." : ""}
              </p>
            </section>
          )}
          {!remove && (
            <section className="rewrite-section">
              <h3>{add ? "Добавить" : "Замена"}</h3>
              {fields && (
                <label>
                  Новое имя
                  <input
                    required={add}
                    value={opts.replacement_name}
                    onChange={(e) =>
                      patch({ replacement_name: e.target.value })
                    }
                    placeholder={
                      add
                        ? "Имя заголовка или параметра"
                        : "Пусто — оставить прежнее имя"
                    }
                  />
                </label>
              )}
              <label>
                Новое значение
                {body ? (
                  <textarea
                    rows={4}
                    disabled={opts.replacement_value === ""}
                    value={opts.replacement_value || ""}
                    onChange={(e) =>
                      patch({ replacement_value: e.target.value || null })
                    }
                    placeholder="Пусто — оставить прежнее значение"
                  />
                ) : (
                  <input
                    disabled={!add && opts.replacement_value === ""}
                    value={opts.replacement_value || ""}
                    onChange={(e) =>
                      patch({ replacement_value: e.target.value || null })
                    }
                    placeholder={
                      draft.action === "status"
                        ? "404"
                        : add
                          ? "Значение (может быть пустым)"
                          : "Пусто — оставить прежнее значение"
                    }
                  />
                )}
              </label>
              {!add && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={opts.replacement_value === ""}
                    onChange={(e) =>
                      patch({ replacement_value: e.target.checked ? "" : null })
                    }
                  />
                  Заменить значение пустой строкой
                </label>
              )}
              {opts.regex && (
                <p className="field-hint">
                  {
                    "Группы соответствующего поля: $1, $2, ${name}. $$ — символ $. Regex использует синтаксис Python."
                  }
                </p>
              )}
            </section>
          )}
          {!add && (
            <fieldset className="rewrite-occurrences">
              <legend>{remove ? "Удалить" : "Заменить"}</legend>
              <label className="checkbox-label">
                <input
                  type="radio"
                  name="rewrite-occurrence"
                  checked={!opts.replace_all}
                  onChange={() => patch({ replace_all: false })}
                />
                Первое совпадение
              </label>
              <label className="checkbox-label">
                <input
                  type="radio"
                  name="rewrite-occurrence"
                  checked={opts.replace_all}
                  onChange={() => patch({ replace_all: true })}
                />
                Все совпадения
              </label>
            </fieldset>
          )}
          {draft.action === "path" && (
            <p className="field-hint">
              Меняется только путь без query. Query-параметры сохраняются.
            </p>
          )}
          {draft.action === "host" && (
            <p className="field-hint">
              Меняет сервер назначения и Host / :authority. Указывайте домен или
              IP без схемы, порта и пути.
            </p>
          )}
          {draft.action === "url" && (
            <p className="field-hint">
              Результат должен быть полным URL с http:// или https://. Пустой
              поиск заменяет URL целиком.
            </p>
          )}
          {draft.action === "status" && (
            <p className="field-hint">
              Например: найти 200 → заменить на 404. Результат — HTTP-статус от
              100 до 599.
            </p>
          )}
        </>
      )}
      {["json", "body"].includes(draft.action) && (
        <p className="field-hint">
          Буферизованные тела до 8 MB. Ошибки и отсутствие совпадений видны в
          инспекторе запроса.
        </p>
      )}
    </>
  );
}
