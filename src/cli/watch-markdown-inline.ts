import { element, type Shown } from "./watch-element.ts";

export function markdownLink(label: string, target: string): Shown {
  if (!/^https?:[/][/]/i.test(target)) return `[${label}](${target})`;
  return element("a", {
    href: target,
    rel: "noopener noreferrer",
    target: "_blank",
    children: markdownInline(label),
  });
}

export interface InlineToken {
  readonly shown: Shown;
  readonly end: number;
}

export function markdownPunctuation(char: string | undefined): boolean {
  return char !== undefined && /^[!-/:-@[-`{-~]$/.test(char);
}

export function markdownEscape(
  text: string,
  at: number,
): InlineToken | undefined {
  const char = text[at + 1];
  if (text[at] !== "\\" || !markdownPunctuation(char)) return undefined;
  return { shown: char ?? "", end: at + 2 };
}

export function markdownRun(text: string, at: number): string {
  const pattern = /`+/y;
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? "";
}

export function markdownCodeText(content: string): string {
  const padded =
    content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "";
  return padded ? content.slice(1, -1) : content;
}

export function markdownCode(text: string, at: number): InlineToken {
  const run = markdownRun(text, at);
  let search = text.indexOf("`", at + run.length);
  while (search >= 0) {
    const close = markdownRun(text, search);
    if (close.length === run.length)
      return {
        shown: element("code", {
          children: markdownCodeText(text.slice(at + run.length, search)),
        }),
        end: search + close.length,
      };
    search = text.indexOf("`", search + close.length);
  }
  return { shown: run, end: at + run.length };
}

export function markdownLinkToken(
  text: string,
  at: number,
): InlineToken | undefined {
  const pattern = /\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/y;
  pattern.lastIndex = at;
  const found = pattern.exec(text);
  if (found === null) return undefined;
  return {
    shown: markdownLink(found[1] ?? "", found[2] ?? ""),
    end: at + found[0].length,
  };
}

export interface InlineRun {
  readonly kind: "run";
  readonly char: string;
  readonly id: number;
  readonly original: number;
  readonly opens: boolean;
  readonly closes: boolean;
  count: number;
}

export type InlineNode =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "shown"; readonly shown: Shown }
  | InlineRun
  | {
      readonly kind: "em" | "strong";
      readonly children: readonly InlineNode[];
    };

interface Placed {
  readonly node: InlineNode;
  readonly end: number;
}

export function markdownSide(char: string): "space" | "mark" | "word" {
  if (/\s/u.test(char)) return "space";
  return /[\p{P}\p{S}]/u.test(char) ? "mark" : "word";
}

export function markdownFlanks(
  text: string,
  span: { readonly at: number; readonly end: number },
) {
  const before = markdownSide(text[span.at - 1] ?? " ");
  const after = markdownSide(text[span.end] ?? " ");
  return {
    left: after === "word" || (after === "mark" && before !== "word"),
    right: before === "word" || (before === "mark" && after !== "word"),
    before,
    after,
  };
}

export function markdownDelimiter(
  text: string,
  place: { readonly at: number; readonly id: number },
): Placed {
  const pattern = /\*+|_+/y;
  pattern.lastIndex = place.at;
  const run = pattern.exec(text)?.[0] ?? "*";
  const end = place.at + run.length;
  const flank = markdownFlanks(text, { at: place.at, end });
  const star = run.startsWith("*");
  const opens = flank.left && (star || !flank.right || flank.before === "mark");
  const closes = flank.right && (star || !flank.left || flank.after === "mark");
  const node: InlineRun = {
    kind: "run",
    char: run.slice(0, 1),
    id: place.id,
    original: run.length,
    count: run.length,
    opens,
    closes,
  };
  return { node, end };
}

export function markdownToken(text: string, at: number) {
  const char = text[at];
  if (char === "`") return markdownCode(text, at);
  if (char === "[") return markdownLinkToken(text, at);
  return markdownEscape(text, at);
}

export function markdownNode(
  text: string,
  place: { readonly at: number; readonly id: number },
): Placed {
  const char = text[place.at] ?? "";
  if (char === "*" || char === "_") return markdownDelimiter(text, place);
  const token = markdownToken(text, place.at);
  if (token === undefined)
    return { node: { kind: "text", text: char }, end: place.at + 1 };
  const { shown } = token;
  const node: InlineNode =
    typeof shown === "string"
      ? { kind: "text", text: shown }
      : { kind: "shown", shown };
  return { node, end: token.end };
}

export function markdownNodes(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let at = 0;
  while (at < text.length) {
    const placed = markdownNode(text, { at, id: nodes.length });
    const last = nodes.at(-1);
    at = placed.end;
    if (placed.node.kind === "text" && last?.kind === "text")
      nodes[nodes.length - 1] = {
        kind: "text",
        text: last.text + placed.node.text,
      };
    else nodes.push(placed.node);
  }
  return nodes;
}

export function markdownPairs(opener: InlineRun, closer: InlineRun): boolean {
  if (opener.char !== closer.char || !opener.opens || opener.count === 0)
    return false;
  const either = opener.closes || closer.opens;
  const sum = (opener.original + closer.original) % 3 === 0;
  const each = opener.original % 3 === 0 && closer.original % 3 === 0;
  return !(either && sum && !each);
}

export function markdownOpener(
  nodes: readonly InlineNode[],
  search: {
    readonly closer: InlineRun;
    readonly at: number;
    readonly bottom: number;
  },
): number {
  for (let index = search.at - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node?.kind !== "run") continue;
    if (node.id <= search.bottom) return -1;
    if (markdownPairs(node, search.closer)) return index;
  }
  return -1;
}

export function markdownMatch(
  nodes: InlineNode[],
  pair: {
    readonly opener: InlineRun;
    readonly closer: InlineRun;
    readonly from: number;
    readonly to: number;
  },
): number {
  const { opener, closer, from, to } = pair;
  const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
  opener.count -= use;
  closer.count -= use;
  const wrapped: InlineNode = {
    kind: use === 2 ? "strong" : "em",
    children: nodes.slice(from + 1, to),
  };
  nodes.splice(from + 1, to - from - 1, wrapped);
  const at = opener.count === 0 ? from + 1 : from + 2;
  if (opener.count === 0) nodes.splice(from, 1);
  if (closer.count === 0) nodes.splice(at, 1);
  return at;
}

export function markdownCloser(
  nodes: InlineNode[],
  state: { readonly at: number; readonly bottoms: Map<string, number> },
): number {
  const closer = nodes[state.at];
  if (closer?.kind !== "run" || !closer.closes || closer.count === 0)
    return state.at + 1;
  const key = `${closer.char}${String(closer.original % 3)}${String(closer.opens)}`;
  const from = markdownOpener(nodes, {
    closer,
    at: state.at,
    bottom: state.bottoms.get(key) ?? -1,
  });
  const opener = nodes[from];
  if (opener?.kind !== "run") {
    state.bottoms.set(key, closer.id - 1);
    return state.at + 1;
  }
  return markdownMatch(nodes, { opener, closer, from, to: state.at });
}

export function markdownEmphasis(nodes: InlineNode[]): InlineNode[] {
  const bottoms = new Map<string, number>();
  let at = 0;
  while (at < nodes.length) at = markdownCloser(nodes, { at, bottoms });
  return nodes;
}

export function markdownNodeShown(node: InlineNode): Shown {
  if (node.kind === "text") return node.text;
  if (node.kind === "run") return node.char.repeat(node.count);
  if (node.kind === "shown") return node.shown;
  return element(node.kind, { children: markdownShown(node.children) });
}

export function markdownShown(nodes: readonly InlineNode[]): Shown[] {
  const parts: Shown[] = [];
  let plain = "";
  for (const node of nodes) {
    const shown = markdownNodeShown(node);
    if (typeof shown === "string") {
      plain += shown;
      continue;
    }
    parts.push(...(plain === "" ? [] : [plain]), shown);
    plain = "";
  }
  return plain === "" ? parts : [...parts, plain];
}

export function markdownInline(text: string): Shown[] {
  return markdownShown(markdownEmphasis(markdownNodes(text)));
}

export const markdownInlineFunctions = [
  markdownLink,
  markdownPunctuation,
  markdownEscape,
  markdownRun,
  markdownCodeText,
  markdownCode,
  markdownLinkToken,
  markdownSide,
  markdownFlanks,
  markdownDelimiter,
  markdownToken,
  markdownNode,
  markdownNodes,
  markdownPairs,
  markdownOpener,
  markdownMatch,
  markdownCloser,
  markdownEmphasis,
  markdownNodeShown,
  markdownShown,
  markdownInline,
];
