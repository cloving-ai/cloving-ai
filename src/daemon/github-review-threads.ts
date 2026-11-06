import { dirname, join } from "node:path";
import { repositoryName } from "./github-issue-methods.ts";
import { issuePrivacy } from "./github-issue-privacy.ts";
import { field, text, type Operation } from "./github-operation.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";

const commentFields =
  "id body createdAt authorAssociation author { login __typename }";
const threadsQuery = `query($owner: String!, $repo: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { state commits(last: 1) { nodes { commit { oid committedDate } } } reviewThreads(first: 100) { nodes { id isResolved isOutdated path line comments(first: 100) { nodes { ${commentFields} } } } } comments(last: 100) { nodes { ${commentFields} } } } } }`;
const replyMutation =
  "mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }";
const resolveMutation =
  "mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }";

const trustedAssociations: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export const threadLimits = {
  bodyCharacters: 3_000,
  threadComments: 6,
  threadsBytes: 120_000,
  commentsBytes: 30_000,
  replyBytes: 65_536,
};

export interface ReviewComment {
  readonly id: string;
  readonly author: string;
  readonly bot: boolean;
  readonly body: string;
  readonly createdAt: string;
}

export interface ReviewThread {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly outdated: boolean;
  readonly bot: boolean;
  readonly comments: readonly ReviewComment[];
}

function nodesOf(value: unknown): readonly unknown[] {
  const nodes = field(value, "nodes");
  return Array.isArray(nodes) ? nodes.map((node: unknown) => node) : [];
}

function stringOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("github-call-failed");
  return value;
}

function numberOf(operation: Operation): number {
  const value = operation.payload["number"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid-payload");
  return value;
}

function nodeText(operation: Operation, name: string): string {
  const value = text(operation, name);
  if (!/^[A-Za-z0-9_=-]{1,128}$/.test(value))
    throw new Error("invalid-payload");
  return value;
}

function graphql(query: string, variables: readonly string[]): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    ...variables.flatMap((variable) => ["-f", variable]),
  ];
}

function commentOf(node: unknown, viewer: string): ReviewComment[] {
  const author = field(node, "author");
  const login = field(author, "login");
  const bot = field(author, "__typename") === "Bot";
  const trusted = trustedAssociations.has(
    String(field(node, "authorAssociation")),
  );
  if (typeof login !== "string") return [];
  if (!bot && !trusted && login !== viewer) return [];
  return [
    {
      id: stringOf(field(node, "id")),
      author: login,
      bot,
      body: String(field(node, "body")).slice(0, threadLimits.bodyCharacters),
      createdAt: stringOf(field(node, "createdAt")),
    },
  ];
}

function kept(comments: readonly ReviewComment[]): readonly ReviewComment[] {
  if (comments.length <= threadLimits.threadComments) return comments;
  return comments
    .slice(0, 1)
    .concat(comments.slice(1 - threadLimits.threadComments));
}

function threadOf(node: unknown, viewer: string): ReviewThread[] {
  if (field(node, "isResolved") !== false) return [];
  const comments = nodesOf(field(node, "comments")).flatMap((item) =>
    commentOf(item, viewer),
  );
  const last = comments.at(-1);
  if (last === undefined || last.author === viewer) return [];
  const line = field(node, "line");
  return [
    {
      id: stringOf(field(node, "id")),
      path: String(field(node, "path")),
      line: typeof line === "number" ? line : null,
      outdated: field(node, "isOutdated") === true,
      bot: comments[0]?.bot ?? last.bot,
      comments: kept(comments),
    },
  ];
}

function latestOf(
  comments: readonly ReviewComment[],
): { readonly id: string; readonly at: string } | null {
  const latest = comments.reduce<ReviewComment | undefined>(
    (newest, item) =>
      newest !== undefined &&
      Date.parse(newest.createdAt) >= Date.parse(item.createdAt)
        ? newest
        : item,
    undefined,
  );
  return latest === undefined ? null : { id: latest.id, at: latest.createdAt };
}

function bounded<Item>(items: readonly Item[], bytes: number): Item[] {
  const result: Item[] = [];
  let used = 0;
  for (const item of items) {
    used += Buffer.byteLength(JSON.stringify(item));
    if (used > bytes) break;
    result.push(item);
  }
  return result;
}

function answeredRecord(
  operation: Operation,
  number: number,
): { readonly folder: string; readonly name: string } {
  return {
    folder: join(dirname(operation.folder), "answered"),
    name: `pull-${String(number)}.json`,
  };
}

async function reviewPull(
  operation: Operation,
  number: number,
): Promise<{ readonly viewer: string; readonly pull: unknown }> {
  const reply: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      "graphql",
      "-f",
      `query=${threadsQuery}`,
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      `number=${String(number)}`,
    ]),
  );
  const data = field(reply, "data");
  return {
    viewer: stringOf(field(field(data, "viewer"), "login")),
    pull: field(field(data, "repository"), "pullRequest"),
  };
}

export async function reviewThreads(operation: Operation): Promise<unknown> {
  const number = numberOf(operation);
  const { viewer, pull } = await reviewPull(operation, number);
  if (field(pull, "state") !== "OPEN") throw new Error("pull-request-not-open");
  const commit = field(nodesOf(field(pull, "commits"))[0], "commit");
  const since = Date.parse(stringOf(field(commit, "committedDate")));
  const threads = nodesOf(field(pull, "reviewThreads")).flatMap((node) =>
    threadOf(node, viewer),
  );
  const comments = nodesOf(field(pull, "comments"))
    .flatMap((node) => commentOf(node, viewer))
    .filter(
      (item) =>
        !item.bot &&
        item.author !== viewer &&
        Date.parse(item.createdAt) > since,
    );
  const record = answeredRecord(operation, number);
  const answered = field(
    await readRecord(record.folder, record.name),
    "comment",
  );
  const latest = latestOf(
    threads.flatMap((thread) => thread.comments.slice(-1)).concat(comments),
  );
  return {
    number,
    head: stringOf(field(commit, "oid")),
    threads: bounded(threads, threadLimits.threadsBytes),
    comments: bounded(comments, threadLimits.commentsBytes),
    latest,
    answered: typeof answered === "string" ? answered : null,
    quietSeconds:
      latest === null
        ? null
        : Math.max(0, Math.floor((Date.now() - Date.parse(latest.at)) / 1000)),
  };
}

export async function recordAnswered(operation: Operation): Promise<unknown> {
  const number = numberOf(operation);
  const comment = nodeText(operation, "comment");
  const record = answeredRecord(operation, number);
  await writeRecord(record.folder, {
    name: record.name,
    value: { pullRequest: number, comment, runId: operation.run.runId },
  });
  return { number, comment };
}

export async function replyThread(operation: Operation): Promise<unknown> {
  const thread = nodeText(operation, "thread");
  const body = text(operation, "body");
  if (Buffer.byteLength(body) > threadLimits.replyBytes)
    throw new Error("invalid-payload");
  const repository = repositoryName(
    await operation.calls.gh(["repo", "view", "--json", "nameWithOwner"]),
  );
  issuePrivacy(body, { settings: operation.settings, repository });
  const reply: unknown = JSON.parse(
    await operation.calls.gh(
      graphql(replyMutation, [`thread=${thread}`, `body=${body}`]),
    ),
  );
  const posted = field(
    field(field(reply, "data"), "addPullRequestReviewThreadReply"),
    "comment",
  );
  return { thread, comment: stringOf(field(posted, "id")) };
}

export async function resolveThread(operation: Operation): Promise<unknown> {
  const thread = nodeText(operation, "thread");
  const reply: unknown = JSON.parse(
    await operation.calls.gh(graphql(resolveMutation, [`thread=${thread}`])),
  );
  const resolved = field(
    field(field(field(reply, "data"), "resolveReviewThread"), "thread"),
    "isResolved",
  );
  if (resolved !== true) throw new Error("github-call-failed");
  return { thread, resolved };
}
