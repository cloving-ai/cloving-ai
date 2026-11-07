import { field, type Operation } from "./github-operation.ts";

const commentFields =
  "id body createdAt authorAssociation author { login __typename }";
const commentPage = `pageInfo { hasPreviousPage startCursor } nodes { ${commentFields} }`;
const threadFields = `id isResolved isOutdated path line root: comments(first: 1) { nodes { ${commentFields} } } recent: comments(last: 10) { ${commentPage} }`;
const threadPage = `reviewThreads(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${threadFields} } }`;
const pullVariables =
  "$owner: String!, $repo: String!, $number: Int!, $cursor: String";
const threadsQuery = `query(${pullVariables}) { viewer { login } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { state commits(last: 1) { nodes { commit { oid committedDate } } } ${threadPage} comments(last: 100) { nodes { ${commentFields} } } } } }`;
const threadPageQuery = `query(${pullVariables}) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${threadPage} } } }`;
const earlierQuery = `query($thread: ID!, $cursor: String!) { node(id: $thread) { ... on PullRequestReviewThread { comments(last: 50, before: $cursor) { ${commentPage} } } } }`;

const trustedAssociations: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

export const pageLimits = {
  bodyCharacters: 3_000,
  threadPages: 20,
  earlierPages: 10,
};

export interface ReviewComment {
  readonly id: string;
  readonly author: string;
  readonly bot: boolean;
  readonly body: string;
  readonly createdAt: string;
}

export interface OpenThread {
  readonly node: unknown;
  readonly comments: readonly ReviewComment[];
}

export interface PullPart {
  readonly number: number;
  readonly viewer: string;
  readonly pull: unknown;
}

export function nodesOf(value: unknown): readonly unknown[] {
  const nodes = field(value, "nodes");
  return Array.isArray(nodes) ? nodes.map((node: unknown) => node) : [];
}

export function stringOf(value: unknown): string {
  if (typeof value !== "string") throw new Error("github-call-failed");
  return value;
}

export function graphql(query: string, variables: readonly string[]): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    ...variables.flatMap((variable) => ["-f", variable]),
  ];
}

export function commentOf(node: unknown, viewer: string): ReviewComment[] {
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
      body: String(field(node, "body")).slice(0, pageLimits.bodyCharacters),
      createdAt: stringOf(field(node, "createdAt")),
    },
  ];
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
    if (page >= pageLimits.threadPages) throw new Error("review-threads-limit");
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

function earlierNeeded(
  page: { readonly nodes: readonly unknown[]; readonly info: unknown },
  viewer: string,
): boolean {
  return (
    field(page.info, "hasPreviousPage") === true &&
    page.nodes.every((node) => commentOf(node, viewer).length === 0)
  );
}

async function earlierPage(
  operation: Operation,
  page: { readonly thread: string; readonly cursor: string },
): Promise<unknown> {
  const reply: unknown = JSON.parse(
    await operation.calls.gh(
      graphql(earlierQuery, [`thread=${page.thread}`, `cursor=${page.cursor}`]),
    ),
  );
  return field(field(field(reply, "data"), "node"), "comments");
}

async function threadComments(
  operation: Operation,
  thread: { readonly node: unknown; readonly viewer: string },
): Promise<readonly ReviewComment[]> {
  const recent = field(thread.node, "recent");
  const nodes = [...nodesOf(recent)];
  let info = field(recent, "pageInfo");
  for (let page = 0; earlierNeeded({ nodes, info }, thread.viewer); page += 1) {
    if (page >= pageLimits.earlierPages)
      throw new Error("review-threads-limit");
    const earlier = await earlierPage(operation, {
      thread: stringOf(field(thread.node, "id")),
      cursor: stringOf(field(info, "startCursor")),
    });
    nodes.unshift(...nodesOf(earlier));
    info = field(earlier, "pageInfo");
  }
  const ids = new Set(nodes.map((node) => field(node, "id")));
  return nodesOf(field(thread.node, "root"))
    .filter((node) => !ids.has(field(node, "id")))
    .concat(nodes)
    .flatMap((node) => commentOf(node, thread.viewer));
}

export async function pullPart(
  operation: Operation,
  number: number,
): Promise<PullPart> {
  const data = await pullPage(operation, {
    number,
    query: threadsQuery,
    cursor: null,
  });
  return {
    number,
    viewer: stringOf(field(field(data, "viewer"), "login")),
    pull: pullOf(data),
  };
}

export async function openThreads(
  operation: Operation,
  part: PullPart,
): Promise<readonly OpenThread[]> {
  const nodes = await reviewThreadNodes(operation, part);
  const threads: OpenThread[] = [];
  for (const node of nodes.filter(
    (item) => field(item, "isResolved") === false,
  )) {
    threads.push({
      node,
      comments: await threadComments(operation, {
        node,
        viewer: part.viewer,
      }),
    });
  }
  return threads;
}
