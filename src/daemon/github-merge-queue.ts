import { setTimeout as delay } from "node:timers/promises";
import { failedChecks, waitForCi, type CiResult } from "./github-ci.ts";
import { list } from "./github-ci-output.ts";
import { knownMerge, type ReviewedPull } from "./github-merge-call.ts";
import {
  checkedLocally,
  conflictChecked,
  finishedMerge,
  merge,
  mergeRepair,
  requireCheck,
  type MergeResult,
  type SuccessfulMerge,
} from "./github-merge.ts";
import {
  field,
  githubTiming,
  repositoryPath,
  type Operation,
} from "./github-operation.ts";
import { githubRead, retryGithub } from "./github-retry.ts";
import { inMergeTurn } from "./merge-turns.ts";

const stateQuery =
  "query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeCommit { oid } mergeQueueEntry { state position } } } }";
const enqueueMutation =
  "mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { state position } } }";
const dequeueMutation =
  "mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { state } } }";

interface QueueEntry {
  readonly state: string;
  readonly position: number;
}

interface QueueState {
  readonly merged: string | undefined;
  readonly head: string;
  readonly entry: QueueEntry | undefined;
}

interface Queued {
  readonly pull: ReviewedPull;
  readonly id: string;
}

interface QueueResult {
  readonly reason: "merge-queue-removed" | "merge-queue-timeout";
  readonly output: string;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("github-call-failed");
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

function entryOf(value: unknown): QueueEntry {
  const position = field(value, "position");
  if (typeof position !== "number") throw new Error("github-call-failed");
  return { state: text(field(value, "state")), position };
}

async function queueState(
  operation: Operation,
  id: string,
): Promise<QueueState> {
  const reply: unknown = JSON.parse(
    await githubRead(operation, graphql(stateQuery, [`id=${id}`])),
  );
  const node = field(field(reply, "data"), "node");
  const state = text(field(node, "state"));
  const entry = field(node, "mergeQueueEntry");
  return {
    merged:
      state === "MERGED"
        ? text(field(field(node, "mergeCommit"), "oid"))
        : undefined,
    head: text(field(node, "headRefOid")),
    entry: entry === null ? undefined : entryOf(entry),
  };
}

function inQueue(state: QueueState): boolean {
  return state.entry !== undefined || state.merged !== undefined;
}

function mergedResult(pull: ReviewedPull, merged: string): SuccessfulMerge {
  return {
    number: pull.number,
    commit: pull.commit,
    updated: pull.commit,
    merged,
  };
}

async function enqueued(operation: Operation, queued: Queued): Promise<void> {
  await retryGithub(operation, {
    action: async (attempt) => {
      if (attempt > 0 && inQueue(await queueState(operation, queued.id)))
        return;
      await operation.calls.gh(
        graphql(enqueueMutation, [
          `id=${queued.id}`,
          `head=${queued.pull.commit}`,
        ]),
      );
    },
  });
}

async function queueEntry(
  operation: Operation,
  pull: ReviewedPull,
): Promise<Queued | MergeResult> {
  const known = await knownMerge(operation, { ...pull, updated: pull.commit });
  if (known.merged !== undefined)
    return finishedMerge(operation, mergedResult(pull, known.merged));
  if (known.node === undefined) throw new Error("github-call-failed");
  const queued = { pull, id: known.node };
  if (inQueue(await queueState(operation, queued.id))) return queued;
  await checkedLocally(operation, pull);
  const ci = await waitForCi(operation, pull.commit);
  if (ci !== undefined) return ci;
  await enqueued(operation, queued);
  return queued;
}

async function groupHead(
  operation: Operation,
  number: number,
): Promise<string | undefined> {
  const reply: unknown = JSON.parse(
    await githubRead(operation, [
      "api",
      `${repositoryPath}/actions/runs?event=merge_group&per_page=100`,
    ]),
  );
  const branch = new RegExp(
    `^gh-readonly-queue/.+/pr-${String(number)}-[0-9a-f]+$`,
  );
  const run = list(field(reply, "workflow_runs")).find((item) =>
    branch.test(String(field(item, "head_branch"))),
  );
  const head = field(run, "head_sha");
  return typeof head === "string" ? head : undefined;
}

async function removal(
  operation: Operation,
  pull: ReviewedPull,
): Promise<CiResult | QueueResult> {
  await conflictChecked(operation, pull.commit);
  const head = await groupHead(operation, pull.number);
  const failed =
    head === undefined ? undefined : await failedChecks(operation, head);
  return (
    failed ?? {
      reason: "merge-queue-removed",
      output:
        "The pull request left the merge queue without a merge. No failed check of a merge group run was found.",
    }
  );
}

async function timedOut(
  operation: Operation,
  wait: { readonly queued: Queued; readonly started: number },
): Promise<QueueResult> {
  await operation.calls.gh(graphql(dequeueMutation, [`id=${wait.queued.id}`]));
  const minutes = Math.round((Date.now() - wait.started) / 60_000);
  return {
    reason: "merge-queue-timeout",
    output: `The pull request was in the merge queue for ${String(minutes)} minutes. Cloving removed it from the queue.`,
  };
}

async function shownEntry(
  operation: Operation,
  view: {
    readonly started: number;
    readonly entry: QueueEntry;
    readonly shown: string;
  },
): Promise<string> {
  const key = `${view.entry.state}/${String(view.entry.position)}`;
  if (key === view.shown) return key;
  await operation.observe?.({
    notice: `merge-queue:${String(view.started)}:${key}`,
    condition: "working",
    reason: "github-merge-queued",
    evidence: `merge-queue/${key}`,
  });
  return key;
}

async function settled(
  operation: Operation,
  queued: Queued,
): Promise<MergeResult | QueueResult> {
  const timing = {
    ...githubTiming,
    queueLimitMilliseconds: 10_800_000,
    ...operation.settings.timing,
  };
  const started = Date.now();
  let shown = "";
  try {
    for (;;) {
      const state = await queueState(operation, queued.id);
      if (state.merged !== undefined && state.head !== queued.pull.commit)
        throw new Error("merged-other-commit");
      if (state.merged !== undefined)
        return await finishedMerge(
          operation,
          mergedResult(queued.pull, state.merged),
        );
      if (state.entry === undefined)
        return await removal(operation, queued.pull);
      shown = await shownEntry(operation, {
        started,
        entry: state.entry,
        shown,
      });
      if (Date.now() - started >= timing.queueLimitMilliseconds)
        return await timedOut(operation, { queued, started });
      await delay(timing.pollMilliseconds, undefined, {
        signal: operation.signal,
      });
    }
  } finally {
    if (shown !== "" && !operation.signal.aborted)
      await operation.observe?.({
        notice: `merge-queue:${String(started)}:done`,
        condition: "working",
        reason: "in-progress",
      });
  }
}

export async function mergeStep(
  operation: Operation,
  pull: ReviewedPull,
): Promise<MergeResult | QueueResult> {
  const turn = {
    repository: operation.settings.repository,
    signal: operation.signal,
  };
  if (operation.settings.mergeMode !== "queue")
    return inMergeTurn(turn, () => merge(operation, pull));
  requireCheck(operation, pull);
  try {
    const entered = await inMergeTurn(turn, () => queueEntry(operation, pull));
    if (!("id" in entered)) return entered;
    return await settled(operation, entered);
  } catch (error) {
    return mergeRepair(operation, error);
  }
}
