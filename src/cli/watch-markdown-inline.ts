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

export function markdownClose(
  text: string,
  place: { readonly from: number; readonly mark: string },
): number {
  const { mark } = place;
  let at = place.from;
  while (at < text.length && text[at] !== "\n") {
    if (text.startsWith(mark, at)) return at;
    if (markdownEscape(text, at) !== undefined) at += 2;
    else if (text[at] === "`") at = markdownCode(text, at).end;
    else at += 1;
  }
  return -1;
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

export function markdownStrong(
  text: string,
  at: number,
): InlineToken | undefined {
  if (!text.startsWith("**", at)) return undefined;
  const close = markdownClose(text, { from: at + 2, mark: "**" });
  if (close <= at + 2) return undefined;
  return {
    shown: element("strong", {
      children: markdownInline(text.slice(at + 2, close)),
    }),
    end: close + 2,
  };
}

export function markdownOutside(mark: string, char: string | undefined) {
  return (mark === "*" ? /[\w*]/ : /\w/).test(char ?? " ");
}

export function markdownOpens(
  text: string,
  place: { readonly at: number; readonly mark: string },
) {
  const { at, mark } = place;
  const after = text[at + 1] ?? " ";
  return (
    !markdownOutside(mark, text[at - 1]) && !/\s/.test(after) && after !== mark
  );
}

export function markdownCloses(
  text: string,
  place: { readonly close: number; readonly mark: string },
) {
  const { close, mark } = place;
  return (
    close >= 0 &&
    !/\s/.test(text[close - 1] ?? " ") &&
    !markdownOutside(mark, text[close + 1])
  );
}

export function markdownEmphasis(
  text: string,
  at: number,
): InlineToken | undefined {
  const mark = text[at] ?? "";
  if (!["*", "_"].includes(mark) || !markdownOpens(text, { at, mark }))
    return undefined;
  const close = markdownClose(text, { from: at + 1, mark });
  if (!markdownCloses(text, { close, mark })) return undefined;
  return {
    shown: element("em", {
      children: markdownInline(text.slice(at + 1, close)),
    }),
    end: close + 1,
  };
}

export function markdownToken(
  text: string,
  at: number,
): InlineToken | undefined {
  if (text[at] === "`") return markdownCode(text, at);
  if (text[at] === "[") return markdownLinkToken(text, at);
  return (
    markdownEscape(text, at) ??
    markdownStrong(text, at) ??
    markdownEmphasis(text, at)
  );
}

export function markdownInline(text: string): Shown[] {
  const parts: Shown[] = [];
  let plain = "";
  let at = 0;
  while (at < text.length) {
    const token = markdownToken(text, at);
    const shown = token === undefined ? (text[at] ?? "") : token.shown;
    at = token === undefined ? at + 1 : token.end;
    if (typeof shown === "string") {
      plain += shown;
      continue;
    }
    parts.push(...(plain === "" ? [] : [plain]), shown);
    plain = "";
  }
  return plain === "" ? parts : [...parts, plain];
}

export const markdownInlineFunctions = [
  markdownLink,
  markdownPunctuation,
  markdownEscape,
  markdownRun,
  markdownCodeText,
  markdownCode,
  markdownClose,
  markdownLinkToken,
  markdownStrong,
  markdownOutside,
  markdownOpens,
  markdownCloses,
  markdownEmphasis,
  markdownToken,
  markdownInline,
];
