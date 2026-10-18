import { issuePrivacy } from "./github-issue-privacy.ts";
import { field, text, type Operation } from "./github-operation.ts";

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

function statusSection(body: string): {
  outside: string;
  lines: readonly string[];
} {
  const heading = /^## Cloving status[ \t]*\r?$/m.exec(body);
  if (heading === null) return { outside: body, lines: [] };
  const after = body
    .slice(heading.index + heading[0].length)
    .replace(/^\r?\n/, "");
  const next = /^#{1,2} /m.exec(after)?.index ?? after.length;
  return {
    outside: body.slice(0, heading.index) + after.slice(next),
    lines: after
      .slice(0, next)
      .trimEnd()
      .split(/\r?\n/)
      .filter((line) => line !== ""),
  };
}

function withStatus(outside: string, lines: readonly string[]): string {
  const separator = "\n".repeat(
    Math.max(0, 2 - (outside.match(/\n*$/)?.[0].length ?? 0)),
  );
  return `${outside}${outside === "" ? "" : separator}## Cloving status\n${lines.join("\n")}\n`;
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
  const line = `Completed in pull request #${String(pull)}.`;
  const lines = section.lines.includes(line)
    ? section.lines
    : [...section.lines, line];
  const body = withStatus(section.outside, lines);
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

function publicRemaining(operation: Operation): string {
  const remaining = remainingItems(operation).join("; ");
  try {
    issuePrivacy(remaining, {
      settings: operation.settings,
      repository: `${text(operation, "owner")}/${text(operation, "repository")}`,
    });
    return remaining;
  } catch {
    return "Remaining work is in the private run report.";
  }
}

export async function partialIssue(operation: Operation): Promise<unknown> {
  const path = issuePath(operation);
  const pull = positiveInteger(operation, "pullRequest");
  const remaining = publicRemaining(operation);
  const issue = await readIssue(operation, path);
  const section = statusSection(issue.body);
  const line = `- Pull request #${String(pull)}: partial. Remaining: ${remaining}`;
  const prefix = `- Pull request #${String(pull)}: partial.`;
  const lines = section.lines.some((item) => item.startsWith(prefix))
    ? section.lines
    : [...section.lines, line];
  const count = lines.filter((item) =>
    /^- Pull request #\d+: partial\./.test(item),
  ).length;
  const label = count >= 3 ? "cloving: blocked" : "cloving: ready";
  const body = withStatus(section.outside, lines);
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
