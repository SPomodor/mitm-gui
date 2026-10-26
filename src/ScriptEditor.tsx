import { useEffect, useId, useRef } from "react";
import { Search } from "lucide-react";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  type Panel,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  search,
  SearchQuery,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import { tags } from "@lezer/highlight";

const externalChange = Annotation.define<boolean>();
const pythonColors = HighlightStyle.define([
  { tag: tags.keyword, class: "script-token-keyword" },
  {
    tag: [tags.string, tags.special(tags.string)],
    class: "script-token-string",
  },
  { tag: [tags.number, tags.bool, tags.null], class: "script-token-value" },
  { tag: tags.comment, class: "script-token-comment" },
  {
    tag: [tags.function(tags.variableName), tags.typeName, tags.meta],
    class: "script-token-function",
  },
]);

function searchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "script-search";
  dom.setAttribute("role", "search");
  dom.setAttribute("aria-label", "Поиск в скрипте");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Найти в скрипте…";
  input.setAttribute("aria-label", "Найти в скрипте");
  input.setAttribute("main-field", "true");
  const count = document.createElement("span");
  count.className = "script-search-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  const button = (label: string, text: string, action: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "icon-button";
    element.setAttribute("aria-label", label);
    element.title = label;
    element.textContent = text;
    element.onclick = action;
    return element;
  };
  const previous = button("Предыдущее совпадение в скрипте", "↑", () =>
    findPrevious(view),
  );
  const next = button("Следующее совпадение в скрипте", "↓", () =>
    findNext(view),
  );
  const close = button("Закрыть поиск в скрипте", "×", () => {
    closeSearchPanel(view);
    view.focus();
  });
  dom.append(input, count, previous, next, close);
  input.oninput = () => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: input.value, literal: true }),
      ),
    });
    if (input.value) findNext(view);
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      (event.shiftKey ? findPrevious : findNext)(view);
    }
  };
  const refresh = () => {
    const query = getSearchQuery(view.state);
    if (input.value !== query.search) input.value = query.search;
    let total = 0,
      active = 0;
    if (query.search && query.valid) {
      const cursor = query.getCursor(view.state);
      const selection = view.state.selection.main;
      for (
        let match = cursor.next();
        !match.done && total < 10000;
        match = cursor.next()
      ) {
        total++;
        if (
          match.value.from === selection.from &&
          match.value.to === selection.to
        )
          active = total;
      }
    }
    count.textContent = `${active}/${total}${total === 10000 ? "+" : ""}`;
    previous.disabled = next.disabled = !total;
  };
  return {
    dom,
    top: true,
    mount() {
      refresh();
      input.focus();
      input.select();
    },
    update: refresh,
  };
}

export default function ScriptEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValue = useRef(value);
  const editable = useRef(new Compartment());
  const hintId = useId();
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          editable.current.of(EditorState.readOnly.of(false)),
          python(),
          lineNumbers(),
          history(),
          drawSelection(),
          indentUnit.of("    "),
          EditorState.tabSize.of(4),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(pythonColors),
          search({ top: true, literal: true, createPanel: searchPanel }),
          keymap.of([
            indentWithTab,
            ...searchKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({
            "aria-label": "Код сценария",
            "aria-describedby": hintId,
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((t) => t.annotation(externalChange))
            )
              onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [hintId]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: 0 },
        annotations: externalChange.of(true),
      });
    }
  }, [value]);
  return (
    <div
      className="script-editor"
      onKeyDownCapture={(event) => {
        const view = editor.current;
        if (!view) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          openSearchPanel(view);
        } else if (event.key === "Escape" && searchPanelOpen(view.state)) {
          event.preventDefault();
          event.stopPropagation();
          closeSearchPanel(view);
          view.focus();
        }
      }}
    >
      <div className="script-editor-tools">
        <span title="Tab — отступ, Shift+Tab — убрать отступ. Ctrl+M переключает Tab на переход между элементами.">
          Python · Tab: 4 пробела
        </span>
        <span id={hintId} className="sr-only">
          Tab добавляет отступ, Shift+Tab убирает. Для перехода из редактора к
          другим элементам нажмите Ctrl+M, затем Tab.
        </span>
        <button
          type="button"
          className="text-button"
          aria-label="Открыть поиск в скрипте"
          onClick={() => editor.current && openSearchPanel(editor.current)}
        >
          <Search size={12} /> Найти · Ctrl+F
        </button>
      </div>
      <div className="script-editor-content" ref={host} />
    </div>
  );
}
