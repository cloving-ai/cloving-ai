import assert from "node:assert/strict";
import type { GithubScene } from "./github-worker-fixture.ts";

export const head = "c".repeat(40);

export const greptile = {
  login: "greptile-apps",
  bot: true,
  association: "NONE",
};

export function at(minute: number): string {
  return `2026-11-06T10:${String(minute).padStart(2, "0")}:00Z`;
}

export function comment(
  id: string,
  fields: {
    readonly login: string;
    readonly minute: number;
    readonly bot?: boolean;
    readonly association?: string;
    readonly body?: string;
  },
) {
  return {
    id,
    body: fields.body ?? `Comment ${id}.`,
    createdAt: at(fields.minute),
    authorAssociation: fields.association ?? "COLLABORATOR",
    author: { login: fields.login, __typename: fields.bot ? "Bot" : "User" },
  };
}

export function thread(
  id: string,
  fields: {
    readonly comments: readonly unknown[];
    readonly resolved?: boolean;
    readonly outdated?: boolean;
    readonly line?: number | null;
  },
) {
  return {
    id,
    isResolved: fields.resolved ?? false,
    isOutdated: fields.outdated ?? false,
    path: "src/a.ts",
    line: fields.line === undefined ? 3 : fields.line,
    comments: { nodes: fields.comments },
  };
}

export function reviewPull(
  threads: readonly unknown[],
  options: {
    readonly comments?: readonly unknown[];
    readonly state?: string;
  } = {},
) {
  return {
    state: options.state ?? "OPEN",
    commits: { nodes: [{ commit: { oid: head, committedDate: at(10) } }] },
    reviewThreads: { nodes: threads },
    comments: { nodes: options.comments ?? [] },
  };
}

export function parsed(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === "object" && value !== null);
  return Object.fromEntries(Object.entries(value));
}

export function listed(value: unknown): readonly Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map((item: unknown) => parsed(JSON.stringify(item)));
}

export async function read(
  scene: GithubScene,
  worker: ReturnType<GithubScene["worker"]>,
) {
  const report = await scene.perform(worker, {
    method: "review-threads",
    payload: { number: 7 },
  });
  assert.equal(report.outcome, "completed", JSON.stringify(report));
  return parsed(String(report.result));
}

export function graphqlCalls(scene: GithubScene, word: string) {
  return scene
    .state()
    .calls.filter(
      (call) =>
        call[1] === "graphql" && call.some((part) => part.includes(word)),
    );
}
