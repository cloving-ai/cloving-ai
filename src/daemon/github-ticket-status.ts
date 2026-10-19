import { issuePrivacy } from "./github-issue-privacy.ts";
import { field, text, type Operation } from "./github-operation.ts";
import { ticketLimits } from "./ticket-source.ts";

const privateRemaining = "Remaining work is in the private run report.";
const issueBodyBytes = ticketLimits.textBytes - 2_048;

const workflowLabels = [
  "cloving: ready",
  "cloving: blocked",
  "cloving: in progress",
];

function positiveInteger(operation: Operation, name: string): number {
  const value = operation.payload[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid-payload");
  return value;
}

function issuePath(operation: Operation): string {
  const repository = `${text(operation, "owner")}/${text(operation, "repository")}`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("invalid-payload");
  return `repos/${repository}/issues/${String(positiveInteger(operation, "number"))}`;
}

function labelsOf(issue: unknown): readonly string[] {
  const labels = field(issue, "labels");
  if (!Array.isArray(labels)) throw new Error("github-call-failed");
  return labels.map((item: unknown) => {
    const name = typeof item === "string" ? item : field(item, "name");
    if (typeof name !== "string") throw new Error("github-call-failed");
    return name;
  });
}

interface Issue {
  readonly state: unknown;
  readonly reason: unknown;
  readonly body: string;
  readonly labels: readonly string[];
}

async function readIssue(operation: Operation, path: string): Promise<Issue> {
  const issue: unknown = JSON.parse(await operation.calls.gh(["api", path]));
  const body = field(issue, "body");
  if (
    (body !== null && typeof body !== "string") ||
    field(issue, "number") !== positiveInteger(operation, "number") ||
    !["open", "closed"].includes(String(field(issue, "state"))) ||
    field(issue, "pull_request") !== undefined
  )
    throw new Error("github-call-failed");
  return {
    state: field(issue, "state"),
    reason: field(issue, "state_reason"),
    body: typeof body === "string" ? body : "",
    labels: labelsOf(issue),
  };
}

interface PartialRun {
  readonly pullRequest: number;
  readonly remaining: readonly string[];
}

interface History {
  readonly version: 1;
  readonly partialRuns: readonly PartialRun[];
  readonly completedPullRequest?: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRemaining(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item: unknown) =>
        typeof item === "string" && item.trim() !== "" && !/[\r\n]/.test(item),
    )
  );
}

function isPartialRun(value: unknown): value is PartialRun {
  return (
    isPositiveInteger(field(value, "pullRequest")) &&
    isRemaining(field(value, "remaining"))
  );
}

function historyOf(json: string): History | undefined {
  try {
    const value: unknown = JSON.parse(json);
    const partialRuns = field(value, "partialRuns");
    const completedPullRequest = field(value, "completedPullRequest");
    if (
      field(value, "version") !== 1 ||
      !Array.isArray(partialRuns) ||
      !partialRuns.every(isPartialRun) ||
      new Set(partialRuns.map((run) => run.pullRequest)).size !==
        partialRuns.length ||
      (completedPullRequest !== undefined &&
        !isPositiveInteger(completedPullRequest))
    )
      return undefined;
    return {
      version: 1,
      partialRuns,
      ...(completedPullRequest === undefined ? {} : { completedPullRequest }),
    };
  } catch {
    return undefined;
  }
}

function statusText(history: History): string {
  const lines = history.partialRuns.map(
    (run) =>
      `- Pull request #${String(run.pullRequest)}: partial. Remaining: ${run.remaining.join("; ")}`,
  );
  if (history.completedPullRequest !== undefined)
    lines.push(
      `Completed in pull request #${String(history.completedPullRequest)}.`,
    );
  return `## Cloving status\n${lines.join("\n")}\n\n`;
}

function legacyFence(line: string): RegExp | undefined {
  const marker =
    /^( {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)? {0,3}(`{3,}|~{3,})/.exec(line);
  if (marker === null || marker[2] === undefined) return undefined;
  const delimiter = marker[2];
  if (delimiter.startsWith("`") && line.slice(marker[0].length).includes("`"))
    return undefined;
  const indentation = (marker[1]?.length ?? 0) + 3;
  return new RegExp(
    `^ {0,${String(indentation)}}${delimiter.charAt(0)}{${String(delimiter.length)},}[ \\t]*\\r?\\n?$`,
  );
}

function legacyStatusStart(body: string): number {
  let fence: RegExp | undefined;
  let offset = 0;
  for (const line of body.split(/(?<=\n)/)) {
    const start = offset;
    offset += line.length;
    if (fence !== undefined) {
      fence = fence.test(line) ? undefined : fence;
      continue;
    }
    if (line.trimEnd() === "## Cloving status") return start;
    fence = legacyFence(line);
  }
  return body.length;
}

function statusSection(body: string): { outside: string; history: History } {
  const empty: History = { version: 1, partialRuns: [] };
  const marker = /^<!-- cloving-status(?=\s|-->|$)/gm;
  const start = [...body.matchAll(marker)].at(-1)?.index;
  if (start === undefined)
    return { outside: body.slice(0, legacyStatusStart(body)), history: empty };
  const tail = body.slice(start);
  const end = tail.indexOf("-->");
  if (end !== -1 && tail.slice(end + 3).trim() !== "")
    return { outside: body, history: empty };
  const outside = body.slice(0, start);
  if (end === -1) return { outside, history: empty };
  const history = historyOf(
    tail.slice("<!-- cloving-status".length, end).trim(),
  );
  if (history === undefined) return { outside, history: empty };
  const section = statusText(history);
  return {
    outside: outside.endsWith(section)
      ? outside.slice(0, -section.length)
      : outside,
    history,
  };
}

function withStatus(outside: string, history: History): string {
  const separator = "\n".repeat(
    Math.max(0, 2 - (outside.match(/\n*$/)?.[0].length ?? 0)),
  );
  const json = JSON.stringify(history)
    .replace(/--/g, "\\u002d\\u002d")
    .replace(/>/g, "\\u003e");
  return `${outside}${outside === "" ? "" : separator}${statusText(history)}<!-- cloving-status\n${json}\n-->\n`;
}

async function writeIssue(
  operation: Operation,
  update: {
    readonly path: string;
    readonly originalBody: string;
    readonly body: string;
    readonly labels: readonly string[];
    readonly fields?: readonly string[];
  },
): Promise<void> {
  const { path, body, labels } = update;
  const latest = await readIssue(operation, path);
  if (latest.body !== update.originalBody)
    throw new Error("github-issue-conflict");
  const fields = update.fields ?? [];
  if (body !== latest.body || fields.length > 0)
    await operation.calls.gh([
      "api",
      "-X",
      "PATCH",
      path,
      "-f",
      `body=${body}`,
      ...fields,
    ]);
  const add = workflowLabels.filter(
    (name) => labels.includes(name) && !latest.labels.includes(name),
  );
  const remove = workflowLabels.filter(
    (name) => !labels.includes(name) && latest.labels.includes(name),
  );
  if (add.length === 0 && remove.length === 0) return;
  await operation.calls.gh([
    "issue",
    "edit",
    String(positiveInteger(operation, "number")),
    "--repo",
    `${text(operation, "owner")}/${text(operation, "repository")}`,
    ...add.flatMap((name) => ["--add-label", name]),
    ...remove.flatMap((name) => ["--remove-label", name]),
  ]);
}

function sameLabels(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return JSON.stringify(first.toSorted()) === JSON.stringify(second.toSorted());
}

export async function closeIssue(operation: Operation): Promise<unknown> {
  const path = issuePath(operation);
  const pull = positiveInteger(operation, "pullRequest");
  const issue = await readIssue(operation, path);
  const section = statusSection(issue.body);
  const body = withStatus(section.outside, {
    ...section.history,
    completedPullRequest: pull,
  });
  const labels = issue.labels.filter(
    (name) =>
      !["cloving: ready", "cloving: blocked", "cloving: in progress"].includes(
        name,
      ),
  );
  if (
    body === issue.body &&
    sameLabels(issue.labels, labels) &&
    issue.state === "closed" &&
    issue.reason === "completed"
  )
    return {
      number: positiveInteger(operation, "number"),
      ticketStatus: "complete",
    };
  await writeIssue(operation, {
    path,
    originalBody: issue.body,
    body,
    labels,
    fields:
      issue.state === "closed" && issue.reason === "completed"
        ? []
        : ["-f", "state=closed", "-f", "state_reason=completed"],
  });
  return {
    number: positiveInteger(operation, "number"),
    ticketStatus: "complete",
  };
}

function remainingItems(operation: Operation): readonly string[] {
  const items = operation.payload["remaining"];
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.some(
      (item: unknown) =>
        typeof item !== "string" || item.trim() === "" || /[\r\n]/.test(item),
    )
  )
    throw new Error("invalid-payload");
  return items.map(String);
}

function publicRemaining(operation: Operation): readonly string[] {
  const remaining = remainingItems(operation);
  try {
    issuePrivacy(remaining.join("; "), {
      settings: operation.settings,
      repository: `${text(operation, "owner")}/${text(operation, "repository")}`,
    });
    return remaining;
  } catch {
    return [privateRemaining];
  }
}

function partialHistory(
  section: ReturnType<typeof statusSection>,
  status: { readonly pull: number; readonly remaining: readonly string[] },
): History {
  const recorded = section.history.partialRuns.some(
    (run) => run.pullRequest === status.pull,
  );
  for (const remaining of [status.remaining, [privateRemaining]]) {
    const history: History = {
      ...section.history,
      partialRuns: recorded
        ? section.history.partialRuns
        : [
            ...section.history.partialRuns,
            { pullRequest: status.pull, remaining },
          ],
    };
    if (
      Buffer.byteLength(withStatus(section.outside, history)) <= issueBodyBytes
    )
      return history;
  }
  throw new Error("github-issue-too-large");
}

export async function partialIssue(operation: Operation): Promise<unknown> {
  const path = issuePath(operation);
  const pull = positiveInteger(operation, "pullRequest");
  const remaining = publicRemaining(operation);
  const issue = await readIssue(operation, path);
  const section = statusSection(issue.body);
  const history = partialHistory(section, { pull, remaining });
  const count = history.partialRuns.length;
  const label = count >= 3 ? "cloving: blocked" : "cloving: ready";
  const body = withStatus(section.outside, history);
  const labels = [
    ...issue.labels.filter(
      (name) =>
        ![
          "cloving: ready",
          "cloving: blocked",
          "cloving: in progress",
        ].includes(name),
    ),
    label,
  ];
  if (body === issue.body && sameLabels(issue.labels, labels))
    return {
      number: positiveInteger(operation, "number"),
      ticketStatus: "partial",
    };
  const repository = `${text(operation, "owner")}/${text(operation, "repository")}`;
  await operation.calls.gh([
    "label",
    "create",
    label,
    "--repo",
    repository,
    "--color",
    "ededed",
    "--force",
  ]);
  await writeIssue(operation, {
    path,
    originalBody: issue.body,
    body,
    labels,
  });
  return {
    number: positiveInteger(operation, "number"),
    ticketStatus: "partial",
  };
}
