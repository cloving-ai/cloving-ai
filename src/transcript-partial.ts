import {
  cutText,
  literal,
  maskedText,
  printable,
  transcriptTextBytes,
  type ShownText,
} from "./transcript-text.ts";

type Control =
  "text" | "escape" | "intermediate" | "csi" | "command" | "command-escape";

export interface PartialText extends ShownText {
  readonly bytes: number;
  readonly pending: string;
  readonly control: Control;
  readonly token: boolean;
}

const encoder = new TextEncoder();
const tokenPrefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];
const trailingToken = /(?:gh[pousr]_|github_pat_)\w*$/i;
const emptyPartial: PartialText = {
  text: "",
  bytes: 0,
  omittedBytes: 0,
  pending: "",
  control: "text",
  token: false,
};
const introductions = new Map<number, Control>([
  [91, "csi"],
  [93, "command"],
]);

function commandControl(control: Control, code: number): Control {
  if (code === 7 || (control === "command-escape" && code === 92))
    return "text";
  return code === 27 ? "command-escape" : "command";
}

function sequenceControl(control: Control, code: number): Control | undefined {
  const introduction = introductions.get(code);
  if (control === "escape" && introduction !== undefined) return introduction;
  const middleEnd = control === "csi" ? 0x3f : 0x2f;
  const finalStart = control === "csi" ? 0x40 : 0x30;
  if (code >= 0x20 && code <= middleEnd)
    return control === "escape" ? "intermediate" : control;
  return code >= finalStart && code <= 0x7e ? "text" : undefined;
}

function cleanChunk(text: string, initial: Control) {
  let control = initial;
  const kept: string[] = [];
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (control === "command" || control === "command-escape") {
      control = commandControl(control, code);
      continue;
    }
    if (control !== "text") {
      const next = sequenceControl(control, code);
      control = next ?? "text";
      if (next !== undefined) continue;
    }
    if (code === 27) control = "escape";
    else if (printable(code)) kept.push(character);
  }
  return { text: kept.join(""), control };
}

function suffixLength(text: string, values: readonly string[]): number {
  let held = 0;
  for (const value of values) {
    const maximum = Math.min(value.length - 1, text.length);
    for (let length = maximum; length > held; length -= 1)
      if (literal(value.slice(0, length)).test(text.slice(-length))) {
        held = length;
        break;
      }
  }
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? Math.max(held, 1) : held;
}

function privateEnd(raw: string, privateTexts: readonly string[]): number {
  const values = privateTexts.filter((value) => value.trim() !== "");
  let end = raw.length - suffixLength(raw, [...values, ...tokenPrefixes]);
  const tokenMatch = trailingToken.exec(raw);
  if (tokenMatch !== null && tokenMatch.index < end) end = raw.length;
  const pattern = values
    .toSorted((first, second) => second.length - first.length)
    .map((value) => literal(value).source)
    .join("|");
  if (pattern !== "")
    for (const match of raw.matchAll(new RegExp(pattern, "gi")))
      if (match.index < end && match.index + match[0].length > end)
        end = match.index;
  return end;
}

function maskChunk(
  previous: PartialText,
  chunk: { readonly text: string; readonly privateTexts: readonly string[] },
) {
  const { text, privateTexts } = chunk;
  const rest = previous.token ? text.replace(/^\w*/, "") : text;
  const raw = previous.pending + rest;
  const end = privateEnd(raw, privateTexts);
  const released = raw.slice(0, end);
  return {
    text: maskedText(released, privateTexts),
    pending: raw.slice(end),
    token:
      trailingToken.test(released) || (previous.token && /^\w*$/.test(text)),
  };
}

export function appendPartial(
  previous: PartialText | undefined,
  chunk: { readonly text: string; readonly privateTexts: readonly string[] },
): PartialText {
  const known = previous ?? emptyPartial;
  const clean = cleanChunk(chunk.text, known.control);
  const hidden = maskChunk(known, { ...chunk, text: clean.text });
  const bytes = known.bytes;
  const limit =
    known.omittedBytes > 0 ? 0 : Math.max(0, transcriptTextBytes - bytes);
  const shown = cutText(hidden.text, limit);
  return {
    text: known.text + shown.text,
    bytes: bytes + encoder.encode(shown.text).length,
    omittedBytes: known.omittedBytes + shown.omittedBytes,
    pending: hidden.pending,
    token: hidden.token,
    control: clean.control,
  };
}
