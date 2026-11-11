import { component, element, type Shown } from "./watch-element.ts";

export interface MarkdownItem {
  readonly text: string;
  readonly nested: boolean;
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

export function markdownItem(
  line: string,
): (MarkdownItem & { readonly number: number | null }) | undefined {
  const found = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
  if (found === null) return undefined;
  return {
    text: found[4] ?? "",
    nested: (found[1] ?? "").length >= 2,
    number: found[3] === undefined ? null : Number(found[3]),
  };
}

export function markdownLineKind(line: string): string {
  if (line.trim() === "") return "blank";
  if (/^\s*```/.test(line)) return "fence";
  if (/^#{1,6}\s+\S/.test(line)) return "heading";
  return markdownItem(line) === undefined ? "text" : "item";
}

export function markdownFence(lines: readonly string[], index: number): Parsed {
  const end = lines.findIndex(
    (line, at) => at > index && /^\s*```\s*$/.test(line),
  );
  const last = end < 0 ? lines.length : end;
  return {
    block: { kind: "code", text: lines.slice(index + 1, last).join("\n") },
    next: last + 1,
  };
}

export function markdownList(lines: readonly string[], index: number): Parsed {
  const first = markdownItem(lines[index] ?? "");
  const ordered = first?.number !== null;
  const items: MarkdownItem[] = [];
  let next = index;
  for (; next < lines.length; next += 1) {
    const item = markdownItem(lines[next] ?? "");
    if (item === undefined || (item.number !== null) !== ordered) break;
    items.push({ text: item.text, nested: item.nested });
  }
  return {
    block: { kind: "list", ordered, start: first?.number ?? 1, items },
    next,
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
        class: item.nested ? "md-nested" : undefined,
        children: markdownInline(item.text),
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
  markdownLineKind,
  markdownFence,
  markdownList,
  markdownText,
  markdownBlock,
  markdownBlocks,
  MarkdownBlockView,
  MarkdownText,
  EntryText,
];
