import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executed = promisify(execFile);
const outputBytes = 16 * 1024 * 1024;
const scorePattern = /greptile_confidence_score:\s*(\d+)/;
const commitPattern = /Last reviewed commit:[^\n]*?\/commit\/([0-9a-f]{7,40})/;

export const reviewer = "greptile-apps[bot]";

export const reviewLimits = {
  summaryCharacters: 4_000,
  findingCharacters: 3_000,
  findingsBytes: 12_000,
};

export interface CallSettings {
  readonly repository: string;
  readonly gh: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly privateTexts?: readonly string[];
}

export interface Calls {
  readonly gh: (parts: readonly string[]) => Promise<string>;
  readonly git: (
    directory: string,
    parts: readonly string[],
  ) => Promise<string>;
  readonly run: (
    command: readonly string[],
    directory: string,
  ) => Promise<string>;
}

export interface Scored {
  readonly score: number;
  readonly summary: string;
}

export interface Finding {
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
}

interface Place {
  readonly directory: string;
  readonly signal: AbortSignal;
  readonly environment: NodeJS.ProcessEnv;
  readonly reason: string;
  readonly privateTexts: readonly string[];
}

function privateEnvironment(environment: NodeJS.ProcessEnv): readonly string[] {
  try {
    const value: unknown = JSON.parse(
      environment["CLOVING_PRIVATE_TEXTS"] ?? "[]",
    );
    return list(value).filter(
      (item): item is string => typeof item === "string",
    );
  } catch {
    return [];
  }
}

function failureDetail(
  error: unknown,
  place: Place,
): { readonly detail: string; readonly status: number } {
  const stderr = field(error, "stderr");
  const text = typeof stderr === "string" ? stderr : "";
  return {
    detail: githubText(text, place).slice(-2_000),
    status: Number(/\(HTTP (\d{3})\)/.exec(text)?.[1]),
  };
}

export function githubText(
  text: string,
  settings: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly privateTexts?: readonly string[];
  },
): string {
  const environment = { ...process.env, ...settings.environment };
  const secrets = Object.entries(environment)
    .filter(([name]) => /TOKEN|SECRET|PASSWORD|KEY/i.test(name))
    .map(([, value]) => value);
  const hidden = [
    ...secrets,
    ...(settings.privateTexts ?? []),
    ...privateEnvironment(environment),
  ]
    .filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    .sort((left, right) => right.length - left.length);
  return hidden.reduce(
    (redacted, value) => redacted.replaceAll(value, "[hidden]"),
    text,
  );
}

async function output(
  command: readonly string[],
  place: Place,
): Promise<string> {
  try {
    const { stdout } = await executed(String(command[0]), command.slice(1), {
      cwd: place.directory,
      env: place.environment,
      signal: place.signal,
      maxBuffer: outputBytes,
    });
    return stdout;
  } catch (error) {
    const failure = new Error(place.reason, { cause: error });
    if (place.reason === "check-failed") throw failure;
    throw Object.assign(failure, failureDetail(error, place));
  }
}

export function calls(settings: CallSettings, signal: AbortSignal): Calls {
  const environment = { ...process.env, ...settings.environment };
  const privateTexts = [
    ...(settings.privateTexts ?? []),
    ...privateEnvironment(environment),
  ];
  const place = (directory: string, reason: string): Place => ({
    directory,
    signal,
    environment,
    reason,
    privateTexts,
  });
  return {
    gh: (parts) =>
      output(
        [...settings.gh, ...parts],
        place(settings.repository, "github-call-failed"),
      ),
    git: (directory, parts) =>
      output(["git", ...parts], place(directory, "git-call-failed")),
    run: (command, directory) =>
      output(command, place(directory, "check-failed")),
  };
}

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

function byReviewer(comment: unknown): boolean {
  return field(field(comment, "user"), "login") === reviewer;
}

function scored(body: string, commit: string): Scored | undefined {
  const score = scorePattern.exec(body)?.[1];
  const reviewed = commitPattern.exec(body)?.[1];
  if (score === undefined || reviewed === undefined) return undefined;
  if (!commit.startsWith(reviewed)) return undefined;
  const summary = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .slice(0, reviewLimits.summaryCharacters);
  return { score: Number(score), summary };
}

export function scoreOf(comments: unknown, commit: string): Scored | undefined {
  return list(comments)
    .filter(byReviewer)
    .map((comment) => scored(String(field(comment, "body")), commit))
    .findLast((item) => item !== undefined);
}

function findingOf(comment: unknown): Finding {
  const line = field(comment, "line") ?? field(comment, "original_line");
  return {
    path: String(field(comment, "path")),
    line: typeof line === "number" ? line : null,
    body: String(field(comment, "body")).slice(
      0,
      reviewLimits.findingCharacters,
    ),
  };
}

function reviewed(comment: unknown, commit: string): boolean {
  return (
    byReviewer(comment) &&
    field(comment, "original_commit_id") === commit &&
    typeof field(comment, "in_reply_to_id") !== "number"
  );
}

export function findingsOf(
  comments: unknown,
  commit: string,
): readonly Finding[] {
  const kept: Finding[] = [];
  let bytes = 0;
  for (const comment of list(comments)) {
    if (!reviewed(comment, commit)) continue;
    const finding = findingOf(comment);
    bytes += Buffer.byteLength(JSON.stringify(finding));
    if (bytes > reviewLimits.findingsBytes) break;
    kept.push(finding);
  }
  return kept;
}
