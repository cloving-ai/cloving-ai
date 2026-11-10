import { record, type Fields } from "../protocol.ts";
import type { TranscriptEntry } from "../turn-transcript.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { counted } from "./watch-render.ts";
import {
  EditLines,
  Gutter,
  LongText,
  TodoLines,
  WriteLines,
  inputText,
  shownPath,
  terminalPartFunctions,
} from "./watch-terminal-parts-view.ts";

export interface TerminalGroup {
  readonly entry: TranscriptEntry;
  readonly results: readonly TranscriptEntry[];
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

export function ToolResult(props: { readonly entry: TranscriptEntry }): Shown {
  const { entry } = props;
  const name = entry.error ? "entry tool-result error" : "entry tool-result";
  const text = entry.text.replace(/\n+$/, "");
  const cut = component(CutNote, { entry });
  if (text.trim() === "")
    return component(Gutter, {
      name,
      children: [element("pre", { children: "(No content)" }), cut],
    });
  const size = counted(text.split("\n").length, "line");
  return element("details", {
    class: name,
    children: [
      element("summary", {
        children: [
          element("span", { class: "gutter", children: "⎿" }),
          entry.error ? ` Error · ${size}` : ` ${size}`,
        ],
      }),
      element("div", {
        class: "output",
        children: [element("pre", { children: text }), cut],
      }),
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
  firstLine,
  toolArgument,
  searchArgument,
  CutNote,
  ToolResult,
  ToolLine,
  ...terminalPartFunctions,
  CallDetail,
  ToolCall,
  TerminalLine,
  TerminalGroupView,
];
