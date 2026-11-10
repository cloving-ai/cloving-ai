import { record, type Fields } from "../protocol.ts";
import type { TranscriptEntry } from "../turn-transcript.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { counted } from "./watch-render.ts";

export interface TerminalGroup {
  readonly entry: TranscriptEntry;
  readonly results: readonly TranscriptEntry[];
}

export interface LineChange {
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

export function terminalGroups(
  entries: readonly TranscriptEntry[],
): TerminalGroup[] {
  const groups: { entry: TranscriptEntry; results: TranscriptEntry[] }[] = [];
  const calls = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    const results =
      entry.kind === "tool-result" ? calls.get(entry.callId ?? "") : undefined;
    if (results !== undefined) {
      results.push(entry);
      continue;
    }
    const group: { entry: TranscriptEntry; results: TranscriptEntry[] } = {
      entry,
      results: [],
    };
    groups.push(group);
    if (entry.kind === "tool-call" && entry.callId !== null)
      calls.set(entry.callId, group.results);
  }
  return groups;
}

export function toolInput(entry: TranscriptEntry): Fields | undefined {
  try {
    return record(JSON.parse(entry.text));
  } catch {
    return undefined;
  }
}

export function inputText(input: Fields, name: string): string {
  const value = input[name];
  return typeof value === "string" ? value : "";
}

export function shownPath(path: string, worktree: string): string {
  if (worktree === "") return path;
  if (path.endsWith(`/${worktree}`)) return ".";
  const marker = `/${worktree}/`;
  const start = path.indexOf(marker);
  return start < 0 ? path : path.slice(start + marker.length);
}

export function firstLine(text: string, limit: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

export function toolArgument(entry: TranscriptEntry, worktree: string): string {
  const tool = entry.tool ?? "";
  const input = toolInput(entry);
  if (input === undefined) return entry.summary.slice(tool.length + 2);
  const paths: Readonly<Record<string, string>> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    MultiEdit: "file_path",
    NotebookEdit: "notebook_path",
  };
  const named: Readonly<Record<string, string>> = {
    Glob: "pattern",
    WebFetch: "url",
    WebSearch: "query",
    Task: "description",
    Agent: "description",
  };
  if (tool === "Bash") return firstLine(inputText(input, "command"), 120);
  if (Object.hasOwn(paths, tool))
    return shownPath(inputText(input, paths[tool] ?? ""), worktree);
  if (tool === "Grep") return searchArgument(input, worktree);
  if (Object.hasOwn(named, tool)) return inputText(input, named[tool] ?? "");
  const first = Object.values(input).find((value) => typeof value === "string");
  return typeof first === "string" ? first : "";
}

export function searchArgument(input: Fields, worktree: string): string {
  const pattern = `pattern: ${JSON.stringify(inputText(input, "pattern"))}`;
  const path = shownPath(inputText(input, "path"), worktree);
  return path === "" ? pattern : `${pattern}, path: ${JSON.stringify(path)}`;
}

export function CutNote(props: { readonly entry: TranscriptEntry }): Shown {
  const { omittedBytes } = props.entry;
  if (omittedBytes === 0) return null;
  return element("p", {
    class: "entry-cut",
    children: `The output is cut: ${String(omittedBytes)} bytes are left out.`,
  });
}

export function LongText(props: {
  readonly text: string;
  readonly head: number;
}): Shown {
  const lines = props.text.replace(/\n+$/, "").split("\n");
  const rest = lines.slice(props.head);
  return [
    element("pre", { children: lines.slice(0, props.head).join("\n") }),
    rest.length === 0
      ? null
      : element("details", {
          children: [
            element("summary", {
              children: `… +${counted(rest.length, "line")}`,
            }),
            element("pre", { children: rest.join("\n") }),
          ],
        }),
  ];
}

export function Gutter(props: {
  readonly name: string;
  readonly children: Shown;
}): Shown {
  return element("div", {
    class: props.name,
    children: [
      element("span", { class: "gutter", children: "⎿" }),
      element("div", { class: "output", children: props.children }),
    ],
  });
}

export function ToolResult(props: { readonly entry: TranscriptEntry }): Shown {
  const { entry } = props;
  return component(Gutter, {
    name: entry.error ? "entry tool-result error" : "entry tool-result",
    children: [
      entry.text.trim() === ""
        ? element("pre", { children: "(No content)" })
        : component(LongText, { text: entry.text, head: 4 }),
      component(CutNote, { entry }),
    ],
  });
}

export function ToolLine(props: {
  readonly entry: TranscriptEntry;
  readonly worktree: string;
}): Shown {
  const { entry, worktree } = props;
  const head =
    entry.tool === "TodoWrite"
      ? [element("strong", { class: "tool-name", children: "Update Todos" })]
      : [
          element("strong", { class: "tool-name", children: entry.tool }),
          `(${toolArgument(entry, worktree)})`,
        ];
  return element("details", {
    class: "tool-line",
    children: [
      element("summary", {
        children: [
          element("span", { class: "mark", children: "⏺" }),
          " ",
          head,
        ],
      }),
      element("pre", { class: "tool-input", children: entry.text }),
      component(CutNote, { entry }),
    ],
  });
}

export function changedLines(before: string, after: string): LineChange {
  const old = before === "" ? [] : before.split("\n");
  const next = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < old.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end += 1;
  return {
    removed: old.slice(start, old.length - end),
    added: next.slice(start, next.length - end),
  };
}

export function inputList(input: Fields, name: string): Fields[] {
  const value = input[name];
  return Array.isArray(value) ? value.map((item) => record(item) ?? {}) : [];
}

export function knownEdits(entry: TranscriptEntry, input: Fields): Fields[] {
  const edits =
    entry.tool === "MultiEdit" ? inputList(input, "edits") : [input];
  const known = edits.every(
    (edit) =>
      typeof edit["old_string"] === "string" &&
      typeof edit["new_string"] === "string",
  );
  return known ? edits : [];
}

export function EditLines(props: {
  readonly entry: TranscriptEntry;
  readonly input: Fields;
  readonly worktree: string;
}): Shown {
  const { entry, input, worktree } = props;
  const changes = knownEdits(entry, input).map((edit) =>
    changedLines(inputText(edit, "old_string"), inputText(edit, "new_string")),
  );
  const added = changes.reduce((sum, change) => sum + change.added.length, 0);
  const removed = changes.reduce(
    (sum, change) => sum + change.removed.length,
    0,
  );
  const path = shownPath(inputText(input, "file_path"), worktree);
  const counts = ` with ${counted(added, "addition")} and ${counted(removed, "removal")}`;
  return component(Gutter, {
    name: "detail",
    children: [
      element("pre", {
        children: `Updated ${path}${changes.length === 0 ? "" : counts}`,
      }),
      changes.length === 0
        ? null
        : element("div", {
            class: "diff",
            children: changes.flatMap((change) => [
              ...change.removed.map((line) =>
                element("div", { class: "removed", children: `- ${line}` }),
              ),
              ...change.added.map((line) =>
                element("div", { class: "added", children: `+ ${line}` }),
              ),
            ]),
          }),
    ],
  });
}

export function WriteLines(props: {
  readonly input: Fields;
  readonly worktree: string;
}): Shown {
  const { input, worktree } = props;
  const content = inputText(input, "content").replace(/\n+$/, "");
  const count = content === "" ? 0 : content.split("\n").length;
  const path = shownPath(inputText(input, "file_path"), worktree);
  return component(Gutter, {
    name: "detail",
    children: [
      element("pre", {
        children: `Wrote ${counted(count, "line")} to ${path}`,
      }),
      content === "" ? null : component(LongText, { text: content, head: 4 }),
    ],
  });
}

export function TodoLines(props: { readonly input: Fields }): Shown {
  return component(Gutter, {
    name: "detail",
    children: inputList(props.input, "todos").map((todo) => {
      const status = inputText(todo, "status");
      const done = status === "completed";
      const name = status === "in_progress" ? "doing" : "open";
      return element("div", {
        class: `todo ${done ? "done" : name}`,
        children: [
          done ? "☒ " : "☐ ",
          element("span", {
            class: "todo-text",
            children: inputText(todo, "content"),
          }),
        ],
      });
    }),
  });
}

export function CallDetail(props: {
  readonly group: TerminalGroup;
  readonly worktree: string;
}): Shown {
  const { group, worktree } = props;
  const { entry, results } = group;
  const input = toolInput(entry);
  const tool = entry.tool ?? "";
  const special = ["Edit", "MultiEdit", "Write", "TodoWrite"].includes(tool);
  const succeeded = results.length > 0 && !results.some((item) => item.error);
  if (input === undefined || !special || !succeeded)
    return results.map((item) =>
      component(ToolResult, { key: String(item.position), entry: item }),
    );
  if (tool === "Write") return component(WriteLines, { input, worktree });
  if (tool === "TodoWrite") return component(TodoLines, { input });
  return component(EditLines, { entry, input, worktree });
}

export function ToolCall(props: {
  readonly group: TerminalGroup;
  readonly worktree: string;
}): Shown {
  const { group, worktree } = props;
  return element("div", {
    class: "entry tool-call",
    children: [
      component(ToolLine, { entry: group.entry, worktree }),
      component(CallDetail, { group, worktree }),
    ],
  });
}

export function TerminalLine(props: {
  readonly entry: TranscriptEntry;
}): Shown {
  const { entry } = props;
  const cut = component(CutNote, { entry });
  if (entry.kind === "tool-result") return component(ToolResult, { entry });
  if (entry.kind === "thinking")
    return element("details", {
      class: "entry thinking",
      children: [
        element("summary", { children: "✻ Thinking…" }),
        element("pre", { children: entry.text }),
        cut,
      ],
    });
  if (entry.kind === "prompt")
    return element("div", {
      class: "entry prompt",
      children: [
        element("span", { class: "mark", children: "> " }),
        element("div", {
          class: "output",
          children: [component(LongText, { text: entry.text, head: 12 }), cut],
        }),
      ],
    });
  return element("div", {
    class: `entry ${entry.kind}${entry.error ? " error" : ""}`,
    children: [
      entry.kind === "assistant"
        ? element("span", { class: "mark", children: "⏺" })
        : null,
      element("pre", { children: entry.text }),
      cut,
    ],
  });
}

export function TerminalGroupView(props: {
  readonly group: TerminalGroup;
  readonly worktree: string;
}): Shown {
  const { group, worktree } = props;
  if (group.entry.kind === "tool-call")
    return component(ToolCall, { group, worktree });
  return component(TerminalLine, { entry: group.entry });
}

export const terminalFunctions = [
  terminalGroups,
  toolInput,
  inputText,
  shownPath,
  firstLine,
  toolArgument,
  searchArgument,
  CutNote,
  LongText,
  Gutter,
  ToolResult,
  ToolLine,
  changedLines,
  inputList,
  knownEdits,
  EditLines,
  WriteLines,
  TodoLines,
  CallDetail,
  ToolCall,
  TerminalLine,
  TerminalGroupView,
];
