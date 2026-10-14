import { homedir } from "node:os";
import { decodeHTMLStrict } from "entities/decode";
import type { MethodSettings } from "./github-operation.ts";

function entity(value: string): string {
  const encoded = `&${value};`;
  const decoded = decodeHTMLStrict(encoded);
  if (decoded === encoded) throw new Error("private-path-in-change");
  return decoded.replace(/\u00a0/g, " ");
}

function decoded(text: string): string {
  return text
    .replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (_match, value: string) =>
      entity(value),
    )
    .replace(/(?:%[\da-f]{2})+/gi, (value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value.replace(/%([\da-f]{2})/gi, (_match, code: string) =>
          String.fromCharCode(Number.parseInt(code, 16)),
        );
      }
    });
}

function linkEnd(
  text: string,
  opening: { readonly index: number; readonly mark: string },
): number | undefined {
  const closing = opening.mark === "[" ? "]" : ")";
  let depth = 0;
  for (let index = opening.index; index < text.length; index += 1) {
    const character = text[index];
    if (character === opening.mark) depth += 1;
    if (character === closing) depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function ambiguousDestination(text: string): boolean {
  return /["'<]/.test(text.replace(/"[^"]*"|'[^']*'|<[^>]*>/g, ""));
}

function visibleLinks(text: string): string {
  let result = "";
  let cursor = 0;
  let position = 0;
  for (;;) {
    const start = text.indexOf("[", position);
    if (start === -1) break;
    const labelEnd = linkEnd(text, { index: start, mark: "[" });
    if (labelEnd === undefined) {
      position = start + 1;
      continue;
    }
    const mark = text[labelEnd + 1];
    if (mark !== "(" && mark !== "[") {
      position = start + 1;
      continue;
    }
    const end = linkEnd(text, { index: labelEnd + 1, mark });
    if (end === undefined) throw new Error("private-path-in-change");
    if (mark === "(" && ambiguousDestination(text.slice(labelEnd + 2, end)))
      throw new Error("private-path-in-change");
    result += text.slice(cursor, start) + text.slice(start + 1, labelEnd);
    cursor = end + 1;
    position = cursor;
  }
  return result + text.slice(cursor);
}

function visible(text: string): string {
  return visibleLinks(text)
    .replace(/<[^>]*>/g, "")
    .replace(/[*`~[\]]/g, "");
}

function paths(text: string): boolean {
  const withoutUrls = text.replace(/https?:\/\/[^\s<>"')]+/gi, (url) => {
    const query = url.search(/[?#]/);
    return query === -1 ? "" : ` ${url.slice(query + 1)}`;
  });
  return [
    /~\//,
    /\.\.\//,
    /[a-z]:[\\/]/i,
    /\\\\[^\s\\]+\\[^\s\\]+/,
    /(?:^|[^\p{L}\p{N}_./\\-])\/{1,2}[^/\s<>"'`]+\/[^\s<>"'`]+/u,
  ].some((pattern) => pattern.test(withoutUrls));
}

function unsafeLinks(text: string): boolean {
  const links = text.matchAll(
    /(?:\]\(\s*<?|<|^\s{0,3}\[[^\]]+\]:\s*<?|\b(?:href|src)\s*=\s*["']?\s*)([a-z][\w+.-]*):|\b([a-z][\w+.-]*):\/\//gim,
  );
  return [...links].some(
    (match) =>
      !["http", "https"].includes(String(match[1] ?? match[2]).toLowerCase()),
  );
}

function mentions(text: string): boolean {
  return [...text.matchAll(/(?:^|[^\w@])@([a-z\d][a-z\d-]*)(\/)?/gi)].some(
    (match) => match[2] !== "/",
  );
}

function foreignIssues(text: string, repository: string): boolean {
  const references = [
    ...text.matchAll(/\b([\w.-]+\/[\w.-]+)#\d+/g),
    ...text.matchAll(
      /https?:\/\/[^/\s]+\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/\d+/gi,
    ),
  ];
  return references.some(
    (match) => match[1]?.toLowerCase() !== repository.toLowerCase(),
  );
}

function privateText(
  text: string,
  options: { readonly texts: readonly string[]; readonly repository: string },
): boolean {
  const lowered = text.toLowerCase();
  return (
    options.texts.some((item) => lowered.includes(item.toLowerCase())) ||
    /gh[pousr]_|github_pat_|sk-ant-|-----BEGIN/i.test(text) ||
    /[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/i.test(text) ||
    mentions(text) ||
    paths(text) ||
    unsafeLinks(text) ||
    foreignIssues(text, options.repository)
  );
}

export function issuePrivacy(
  text: string,
  options: { readonly settings: MethodSettings; readonly repository: string },
): void {
  const { settings, repository } = options;
  const operatorTexts = operatorPrivateTexts(settings);
  const texts = [
    homedir(),
    settings.repository,
    settings.worktrees,
    ...operatorTexts,
  ];
  const plain = decoded(text);
  const unescaped = plain.replace(/\\([^\p{L}\p{N}\s])/gu, "$1");
  const rendered = visible(unescaped);
  const forms = [text, plain, unescaped, rendered, rendered.replace(/_/g, "")];
  if (forms.some((form) => privateText(form, { texts, repository })))
    throw new Error("private-path-in-change");
}

export function operatorPrivateTexts(
  settings: MethodSettings,
): readonly string[] {
  const texts =
    settings.privateTexts?.filter((item) => item.trim() !== "") ?? [];
  if (texts.length === 0) throw new Error("private-texts-not-set");
  return texts;
}
