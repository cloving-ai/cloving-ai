import { component, element, type Shown } from "./watch-element.ts";

export interface MarkdownItem {
  readonly text: string;
  readonly blocks: readonly MarkdownBlock[];
}

export interface ItemLine {
  readonly text: string;
  readonly indent: number;
  readonly number: number | null;
}

export type MarkdownBlock =
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly MarkdownItem[];
    }
  | { readonly kind: "text"; readonly text: string };

interface Parsed {
  readonly block: MarkdownBlock;
  readonly next: number;
}

export function markdownLink(label: string, target: string): Shown {
  if (!/^https?:[/][/]/i.test(target)) return `[${label}](${target})`;
  return element("a", {
    href: target,
    rel: "noopener noreferrer",
    target: "_blank",
    children: markdownInline(label),
  });
}

export function markdownSpan(token: string): Shown {
  if (token.startsWith("`"))
    return element("code", { children: token.slice(1, -1) });
  if (token.startsWith("**"))
    return element("strong", { children: markdownInline(token.slice(2, -2)) });
  if (token.startsWith("[")) {
    const split = token.indexOf("](");
    return markdownLink(token.slice(1, split), token.slice(split + 2, -1));
  }
  return element("em", { children: markdownInline(token.slice(1, -1)) });
}

export function markdownInline(text: string): Shown[] {
  const pattern =
    /`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*(?![\s*])[^*\n]*?[^\s*]\*(?![\w*])|(?<!\w)_(?![\s_])[^_\n]*?[^\s_]_(?!\w)|\[[^\]\n]+\]\([^()\s]*(?:\([^()\s]*\)[^()\s]*)*\)/g;
  const parts: Shown[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) parts.push(text.slice(start, match.index));
    parts.push(markdownSpan(match[0]));
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

export function markdownItem(line: string): ItemLine | undefined {
  const found = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
  if (found === null) return undefined;
  return {
    text: found[4] ?? "",
    indent: (found[1] ?? "").length,
    number: found[3] === undefined ? null : Number(found[3]),
  };
}

export function markdownFenceMark(line: string): string | undefined {
  return /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
}

export function markdownLineKind(line: string): string {
  if (line.trim() === "") return "blank";
  if (markdownFenceMark(line) !== undefined) return "fence";
  if (/^#{1,6}\s+\S/.test(line)) return "heading";
  return markdownItem(line) === undefined ? "text" : "item";
}

export function markdownFence(lines: readonly string[], index: number): Parsed {
  const opening = markdownFenceMark(lines[index] ?? "") ?? "```";
  const end = lines.findIndex((line, at) => {
    const closing = /^\s*(`+|~+)\s*$/.exec(line)?.[1] ?? "";
    return (
      at > index &&
      closing[0] === opening[0] &&
      closing.length >= opening.length
    );
  });
  const last = end < 0 ? lines.length : end;
  const pad = markdownIndent(lines[index] ?? "");
  const code = lines
    .slice(index + 1, last)
    .map((line) => line.slice(Math.min(pad, markdownIndent(line))));
  return {
    block: { kind: "code", text: code.join("\n") },
    next: last + 1,
  };
}

export function markdownIndent(line: string): number {
  return line.length - line.trimStart().length;
}

interface ListState {
  readonly next: number;
  readonly indent: number;
  readonly ordered: boolean;
  readonly items: { text: string; readonly blocks: MarkdownBlock[] }[];
}

export function markdownListItem(
  lines: readonly string[],
  state: ListState & { readonly item: ItemLine },
): number | undefined {
  const { item } = state;
  const last = state.items.at(-1);
  if (item.indent < state.indent) return undefined;
  if (item.indent > state.indent && last !== undefined) {
    const nested = markdownList(lines, state.next);
    last.blocks.push(nested.block);
    return nested.next;
  }
  if ((item.number !== null) !== state.ordered) return undefined;
  state.items.push({ text: item.text, blocks: [] });
  return state.next + 1;
}

export function markdownListGap(
  lines: readonly string[],
  state: ListState,
): number | undefined {
  const after = lines[state.next + 1] ?? "";
  const item = markdownItem(after);
  if (item !== undefined && item.indent >= state.indent) return state.next + 1;
  if (after.trim() === "" || item !== undefined) return undefined;
  const inside = state.items.length > 0 && markdownIndent(after) > state.indent;
  return inside ? state.next + 1 : undefined;
}

export function markdownListMore(
  lines: readonly string[],
  state: ListState,
): number | undefined {
  const line = lines[state.next] ?? "";
  const last = state.items.at(-1);
  if (last === undefined || markdownIndent(line) <= state.indent)
    return undefined;
  if (markdownLineKind(line) === "fence") {
    const fence = markdownFence(lines, state.next);
    last.blocks.push(fence.block);
    return fence.next;
  }
  const gap = (lines[state.next - 1] ?? "").trim() === "";
  if (gap || last.blocks.length > 0)
    last.blocks.push({ kind: "text", text: line.trim() });
  else last.text = `${last.text}\n${line.trim()}`;
  return state.next + 1;
}

export function markdownListStep(
  lines: readonly string[],
  state: ListState,
): number | undefined {
  const line = lines[state.next];
  if (line === undefined) return undefined;
  const item = markdownItem(line);
  if (item !== undefined) return markdownListItem(lines, { ...state, item });
  if (line.trim() === "") return markdownListGap(lines, state);
  return markdownListMore(lines, state);
}

export function markdownList(lines: readonly string[], index: number): Parsed {
  const first = markdownItem(lines[index] ?? "");
  const items: ListState["items"] = [];
  const shape = {
    indent: first?.indent ?? 0,
    ordered: first?.number !== null,
    items,
  };
  let next: number | undefined = index;
  let end = index;
  while (next !== undefined) {
    end = next;
    next = markdownListStep(lines, { ...shape, next });
  }
  return {
    block: {
      kind: "list",
      ordered: shape.ordered,
      start: first?.number ?? 1,
      items,
    },
    next: end,
  };
}

export function markdownText(lines: readonly string[], index: number): Parsed {
  let next = index + 1;
  while (next < lines.length && markdownLineKind(lines[next] ?? "") === "text")
    next += 1;
  return {
    block: { kind: "text", text: lines.slice(index, next).join("\n") },
    next,
  };
}

export function markdownBlock(lines: readonly string[], index: number): Parsed {
  const line = lines[index] ?? "";
  const kind = markdownLineKind(line);
  if (kind === "fence") return markdownFence(lines, index);
  if (kind === "item") return markdownList(lines, index);
  if (kind === "text") return markdownText(lines, index);
  const level = /^#+/.exec(line)?.[0].length ?? 1;
  const text = line.slice(level).trim();
  return { block: { kind: "heading", level, text }, next: index + 1 };
}

export function markdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (markdownLineKind(lines[index] ?? "") === "blank") {
      index += 1;
      continue;
    }
    const parsed = markdownBlock(lines, index);
    blocks.push(parsed.block);
    index = parsed.next;
  }
  return blocks;
}

export function MarkdownBlockView(props: {
  readonly block: MarkdownBlock;
}): Shown {
  const { block } = props;
  if (block.kind === "code")
    return element("pre", {
      class: "md-code",
      children: element("code", { children: block.text }),
    });
  if (block.kind === "heading")
    return element(`h${String(block.level)}`, {
      children: markdownInline(block.text),
    });
  if (block.kind === "text")
    return element("p", { children: markdownInline(block.text) });
  return element(block.ordered ? "ol" : "ul", {
    start: block.ordered && block.start !== 1 ? String(block.start) : undefined,
    children: block.items.map((item) =>
      element("li", {
        children: [
          markdownInline(item.text),
          item.blocks.map((inner, index) =>
            component(MarkdownBlockView, { key: String(index), block: inner }),
          ),
        ],
      }),
    ),
  });
}

export function MarkdownText(props: { readonly text: string }): Shown {
  return element("div", {
    class: "markdown",
    children: markdownBlocks(props.text).map((block, index) =>
      component(MarkdownBlockView, { key: String(index), block }),
    ),
  });
}

export function EntryText(props: {
  readonly kind: string;
  readonly text: string;
}): Shown {
  if (props.kind === "assistant")
    return component(MarkdownText, { text: props.text });
  return element("pre", { children: props.text });
}

export const markdownFunctions = [
  markdownLink,
  markdownSpan,
  markdownInline,
  markdownItem,
  markdownFenceMark,
  markdownLineKind,
  markdownFence,
  markdownIndent,
  markdownListItem,
  markdownListGap,
  markdownListMore,
  markdownListStep,
  markdownList,
  markdownText,
  markdownBlock,
  markdownBlocks,
  MarkdownBlockView,
  MarkdownText,
  EntryText,
];
