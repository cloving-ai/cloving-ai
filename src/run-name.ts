export const titleSources = [
  "manual",
  "ticket",
  "pull-request",
  "input",
  "prompt",
  "fallback",
] as const;

export type TitleSource = (typeof titleSources)[number];

export const labelSources = ["manual", "ticket", "title"] as const;

export type LabelSource = (typeof labelSources)[number];

export interface ManualName {
  readonly title: string;
  readonly label: string | null;
}

export interface NameSources {
  readonly manual: ManualName | null;
  readonly ticket: {
    readonly id: string | null;
    readonly text: string | null;
    readonly issueNumber: number | null;
  };
  readonly pullRequestTitle: string | null;
  readonly input: Readonly<Record<string, unknown>> | null;
  readonly prompt: string | null;
  readonly fallback: string;
}

export interface RunName {
  readonly title: string;
  readonly titleSource: TitleSource;
  readonly label: string | null;
  readonly labelSource: LabelSource | null;
}

export const titleLimit = 200;
const promptLimit = 80;
const ticketKey = /^((?=[0-9]*[A-Z])[A-Z0-9]{2,}-[0-9]+)(?![A-Za-z0-9])/;
const labelPattern = /^[\p{L}\p{N}#!._/-]{1,32}$/u;
const controlPattern = /\p{Cc}/u;

function limited(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

function lines(value: unknown): readonly string[] {
  return typeof value === "string" ? value.split(/\r?\n/) : [];
}

function firstLine(value: unknown): string | null {
  const line = lines(value)
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? null : limited(line, titleLimit);
}

function ticketTitle(text: string | null): string | null {
  const first = lines(text)[0] ?? "";
  if (!first.startsWith("# ")) return null;
  const title = first.slice(2).trim();
  return title === "" ? null : limited(title, titleLimit);
}

function wordCut(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= promptLimit) return text;
  const head = characters.slice(0, promptLimit).join("");
  if (/\s/.test(characters[promptLimit] ?? "")) return head.trimEnd();
  const end = head.search(/\s\S*$/);
  return end > 0 ? head.slice(0, end).trimEnd() : head;
}

function promptTitle(text: string | null): string | null {
  const line = lines(text)
    .map((part) => part.replace(/^\s*# /, "").trim())
    .find((part) => part !== "");
  return line === undefined ? null : wordCut(line);
}

type Found = readonly [TitleSource, string];

function found(entry: readonly [TitleSource, string | null]): entry is Found {
  return entry[1] !== null;
}

function titleOf(sources: NameSources): Found {
  const candidates: readonly (readonly [TitleSource, string | null])[] = [
    ["manual", sources.manual?.title ?? null],
    ["ticket", ticketTitle(sources.ticket.text)],
    ["pull-request", firstLine(sources.pullRequestTitle)],
    ["input", firstLine(sources.input?.["title"])],
    ["prompt", promptTitle(sources.prompt) ?? promptTitle(sources.ticket.text)],
  ];
  return candidates.find(found) ?? ["fallback", sources.fallback];
}

function ticketLabel(ticket: NameSources["ticket"]): string | null {
  if (ticket.issueNumber !== null) return `#${String(ticket.issueNumber)}`;
  if (ticket.id === null || ticket.id === "") return null;
  return /^\d+$/.test(ticket.id) ? `#${ticket.id}` : ticket.id;
}

function labelOf(
  sources: NameSources,
  title: string,
): Pick<RunName, "label" | "labelSource"> {
  const manual = sources.manual?.label ?? null;
  if (manual !== null) return { label: manual, labelSource: "manual" };
  const ticket = ticketLabel(sources.ticket);
  if (ticket !== null) return { label: ticket, labelSource: "ticket" };
  const key = ticketKey.exec(title)?.[1];
  return key === undefined
    ? { label: null, labelSource: null }
    : { label: key, labelSource: "title" };
}

export function runName(sources: NameSources): RunName {
  const [titleSource, title] = titleOf(sources);
  return { title, titleSource, ...labelOf(sources, title) };
}

export function runTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  const length = Array.from(title).length;
  if (length < 1 || length > titleLimit) return undefined;
  return controlPattern.test(title) ? undefined : title;
}

export function isRunTitle(value: unknown): value is string {
  return runTitle(value) === value;
}

export function runLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return labelPattern.test(label) ? label : undefined;
}

export function isRunLabel(value: unknown): value is string {
  return runLabel(value) === value;
}

export function manualNameOf(
  renames: readonly Readonly<Record<string, string>>[],
): ManualName | null {
  const newest = renames.at(-1);
  const title = newest?.["title"];
  if (title === undefined) return null;
  return { title, label: newest?.["label"] ?? null };
}
