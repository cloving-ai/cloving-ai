import { basename, dirname, join } from "node:path";
import { repositoryName } from "./github-issue-methods.ts";
import { issuePrivacy } from "./github-issue-privacy.ts";
import { field, text, type Operation } from "./github-operation.ts";
import { readRecord, writeRecord } from "./operation-journal.ts";

const commentFields =
  "id body createdAt authorAssociation author { login __typename }";
const threadFields = `id isResolved isOutdated path line root: comments(first: 1) { nodes { ${commentFields} } } recent: comments(last: 10) { nodes { ${commentFields} } }`;
const threadPage = `reviewThreads(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${threadFields} } }`;
const pullVariables =
  "$owner: String!, $repo: String!, $number: Int!, $cursor: String";
const threadsQuery = `query(${pullVariables}) { viewer { login } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { state commits(last: 1) { nodes { commit { oid committedDate } } } ${threadPage} comments(last: 100) { nodes { ${commentFields} } } } } }`;
const threadPageQuery = `query(${pullVariables}) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${threadPage} } } }`;
const repliesQuery =
  "query($thread: ID!) { viewer { login } node(id: $thread) { ... on PullRequestReviewThread { comments(last: 50) { nodes { id body author { login } } } } } }";
const replyMutation =
  "mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }";
const resolveMutation =
  "mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } } }";

const nodeId = /^[A-Za-z0-9_=-]{1,128}$/;
const trustedAssociations: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export const threadLimits = {
  bodyCharacters: 3_000,
  threadComments: 6,
  threadPages: 20,
  threadsBytes: 120_000,
  commentsBytes: 30_000,
  replyBytes: 65_536,
  recordedComments: 100,
  answeredComments: 500,
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
  readonly answered: boolean;
  readonly comments: readonly ReviewComment[];
}

interface ThreadContext {
  readonly viewer: string;
  readonly answered: ReadonlySet<string>;
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
  if (!nodeId.test(value)) throw new Error("invalid-payload");
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

function threadNodes(node: unknown): readonly unknown[] {
  const recent = nodesOf(field(node, "recent"));
  const ids = new Set(recent.map((item) => field(item, "id")));
  return nodesOf(field(node, "root"))
    .filter((item) => !ids.has(field(item, "id")))
    .concat(recent);
}

function threadOf(node: unknown, context: ThreadContext): ReviewThread[] {
  if (field(node, "isResolved") !== false) return [];
  const { viewer } = context;
  const comments = threadNodes(node).flatMap((item) => commentOf(item, viewer));
  const last = comments.at(-1);
  if (last === undefined || last.author === viewer) return [];
  const line = field(node, "line");
  const root = nodesOf(field(node, "root"))[0];
  return [
    {
      id: stringOf(field(node, "id")),
      path: String(field(node, "path")),
      line: typeof line === "number" ? line : null,
      outdated: field(node, "isOutdated") === true,
      bot: field(field(root, "author"), "__typename") === "Bot",
      answered: context.answered.has(last.id),
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

async function pullPage(
  operation: Operation,
  page: {
    readonly number: number;
    readonly query: string;
    readonly cursor: string | null;
  },
): Promise<unknown> {
  const cursor = page.cursor === null ? [] : ["-f", `cursor=${page.cursor}`];
  const reply: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      "graphql",
      "-f",
      `query=${page.query}`,
      "-F",
      "owner={owner}",
      "-F",
      "repo={repo}",
      "-F",
      `number=${String(page.number)}`,
      ...cursor,
    ]),
  );
  return field(reply, "data");
}

function pullOf(data: unknown): unknown {
  return field(field(data, "repository"), "pullRequest");
}

async function reviewThreadNodes(
  operation: Operation,
  first: { readonly number: number; readonly pull: unknown },
): Promise<readonly unknown[]> {
  const nodes = [...nodesOf(field(first.pull, "reviewThreads"))];
  let info = field(field(first.pull, "reviewThreads"), "pageInfo");
  for (let page = 1; field(info, "hasNextPage") === true; page += 1) {
    if (page >= threadLimits.threadPages)
      throw new Error("review-threads-limit");
    const pull = pullOf(
      await pullPage(operation, {
        number: first.number,
        query: threadPageQuery,
        cursor: stringOf(field(info, "endCursor")),
      }),
    );
    nodes.push(...nodesOf(field(pull, "reviewThreads")));
    info = field(field(pull, "reviewThreads"), "pageInfo");
  }
  return nodes;
}

async function answeredComments(
  operation: Operation,
  number: number,
): Promise<readonly string[]> {
  const record = answeredRecord(operation, number);
  const comments = field(
    await readRecord(record.folder, record.name),
    "comments",
  );
  if (!Array.isArray(comments)) return [];
  return comments.filter((item) => typeof item === "string");
}

export async function reviewThreads(operation: Operation): Promise<unknown> {
  const number = numberOf(operation);
  const data = await pullPage(operation, {
    number,
    query: threadsQuery,
    cursor: null,
  });
  const viewer = stringOf(field(field(data, "viewer"), "login"));
  const pull = pullOf(data);
  if (field(pull, "state") !== "OPEN") throw new Error("pull-request-not-open");
  const commit = field(nodesOf(field(pull, "commits"))[0], "commit");
  const since = Date.parse(stringOf(field(commit, "committedDate")));
  const context = {
    viewer,
    answered: new Set(await answeredComments(operation, number)),
  };
  const threads = (await reviewThreadNodes(operation, { number, pull }))
    .flatMap((node) => threadOf(node, context))
    .sort((left, right) => Number(left.answered) - Number(right.answered));
  const comments = nodesOf(field(pull, "comments"))
    .flatMap((node) => commentOf(node, viewer))
    .filter(
      (item) =>
        !item.bot &&
        item.author !== viewer &&
        Date.parse(item.createdAt) > since,
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
    quietSeconds:
      latest === null
        ? null
        : Math.max(0, Math.floor((Date.now() - Date.parse(latest.at)) / 1000)),
  };
}

function commentIds(operation: Operation): readonly string[] {
  const comments = operation.payload["comments"];
  if (
    !Array.isArray(comments) ||
    comments.length === 0 ||
    comments.length > threadLimits.recordedComments
  )
    throw new Error("invalid-payload");
  return comments.map((item) => {
    if (typeof item !== "string" || !nodeId.test(item))
      throw new Error("invalid-payload");
    return item;
  });
}

export async function recordAnswered(operation: Operation): Promise<unknown> {
  const number = numberOf(operation);
  const comments = commentIds(operation);
  const record = answeredRecord(operation, number);
  const known = await answeredComments(operation, number);
  const answered = [...new Set(known.concat(comments))].slice(
    -threadLimits.answeredComments,
  );
  await writeRecord(record.folder, {
    name: record.name,
    value: {
      pullRequest: number,
      comments: answered,
      runId: operation.run.runId,
    },
  });
  return { number, comments };
}

async function postedReply(
  operation: Operation,
  reply: { readonly thread: string; readonly marker: string },
): Promise<string | undefined> {
  const data = field(
    JSON.parse(
      await operation.calls.gh(
        graphql(repliesQuery, [`thread=${reply.thread}`]),
      ),
    ),
    "data",
  );
  const viewer = stringOf(field(field(data, "viewer"), "login"));
  const posted = nodesOf(field(field(data, "node"), "comments")).find(
    (node) =>
      field(field(node, "author"), "login") === viewer &&
      String(field(node, "body")).includes(reply.marker),
  );
  const id = field(posted, "id");
  return typeof id === "string" ? id : undefined;
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
  const marker = `<!-- cloving-reply:${basename(operation.folder)} -->`;
  const known = await postedReply(operation, { thread, marker });
  if (known !== undefined) return { thread, comment: known };
  const reply: unknown = JSON.parse(
    await operation.calls.gh(
      graphql(replyMutation, [`thread=${thread}`, `body=${body}\n\n${marker}`]),
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
