export interface ShownText {
  readonly text: string;
  readonly omittedBytes: number;
}

export const transcriptTextBytes = 65_536;

const escapeCode = 27;
const bellCode = 7;
const tokenPattern = /(?:gh[pousr]_|github_pat_)\w*/gi;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function within(code: number, range: readonly [number, number]): boolean {
  return code >= range[0] && code <= range[1];
}

function sequenceTail(
  text: string,
  rule: {
    readonly start: number;
    readonly middle: readonly [number, number];
    readonly final: readonly [number, number];
  },
): number {
  let index = rule.start;
  while (index < text.length && within(text.charCodeAt(index), rule.middle))
    index += 1;
  return index < text.length && within(text.charCodeAt(index), rule.final)
    ? index + 1
    : index;
}

function commandEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === bellCode) return index + 1;
    if (code === escapeCode && text[index + 1] === "\\") return index + 2;
  }
  return text.length;
}

function sequenceEnd(text: string, start: number): number {
  const introducer = text[start + 1];
  if (introducer === "[")
    return sequenceTail(text, {
      start: start + 2,
      middle: [0x20, 0x3f],
      final: [0x40, 0x7e],
    });
  if (introducer === "]") return commandEnd(text, start + 2);
  return sequenceTail(text, {
    start: start + 1,
    middle: [0x20, 0x2f],
    final: [0x30, 0x7e],
  });
}

function printable(code: number): boolean {
  if (code === 9 || code === 10) return true;
  return code >= 32 && (code < 0x7f || code > 0x9f);
}

export function withoutControls(text: string): string {
  const kept: string[] = [];
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === escapeCode) {
      index = sequenceEnd(text, index);
      continue;
    }
    if (printable(code)) kept.push(text.charAt(index));
    index += 1;
  }
  return kept.join("");
}

function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

export function maskedText(
  text: string,
  privateTexts: readonly string[],
): string {
  const hidden = privateTexts
    .filter((item) => item.trim() !== "")
    .toSorted((first, second) => second.length - first.length)
    .reduce(
      (current, item) => current.replace(literal(item), "[hidden]"),
      text,
    );
  return hidden.replace(tokenPattern, "[hidden]");
}

export function cutText(text: string, limit: number): ShownText {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return { text, omittedBytes: 0 };
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return {
    text: decoder.decode(bytes.subarray(0, end)),
    omittedBytes: bytes.length - end,
  };
}

export function shownText(
  text: string,
  privateTexts: readonly string[],
): ShownText {
  return cutText(
    maskedText(withoutControls(text), privateTexts),
    transcriptTextBytes,
  );
}
