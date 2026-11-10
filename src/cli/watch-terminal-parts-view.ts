import { record, type Fields } from "../protocol.ts";
import type { TranscriptEntry } from "../turn-transcript.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { counted } from "./watch-render.ts";

export interface LineChange {
  readonly removed: readonly string[];
  readonly added: readonly string[];
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

export const terminalPartFunctions = [
  inputText,
  shownPath,
  LongText,
  Gutter,
  changedLines,
  inputList,
  knownEdits,
  EditLines,
  WriteLines,
  TodoLines,
];
