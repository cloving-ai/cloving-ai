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
import { readRecord, writeRecord } from "./operation-journal.ts";
import { inMergeTurn } from "./merge-turns.ts";

const stateQuery =
  "query($id: ID!) { node(id: $id) { ... on PullRequest { state headRefOid mergeCommit { oid } mergeQueueEntry { state position enqueuedAt } } } }";
const enqueueMutation =
  "mutation($id: ID!, $head: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { state position enqueuedAt } } }";
const queueRecord = "merge-queue.json";
const groupPageLimit = 10;
const dequeueMutation =
  "mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { state } } }";

interface QueueEntry {
  readonly state: string;
  readonly position: number;
  readonly enqueuedAt: number;
}

interface MergedState {
  readonly kind: "merged";
  readonly head: string;
  readonly merged: string;
}

type InQueue =
  MergedState | { readonly kind: "queued"; readonly entry: QueueEntry };

type QueueState = InQueue | { readonly kind: "left" };

interface Target {
  readonly pull: ReviewedPull;
  readonly id: string;
}

interface Queued extends Target {
  readonly started: number;
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
  const enqueuedAt = Date.parse(text(field(value, "enqueuedAt")));
  if (typeof position !== "number" || Number.isNaN(enqueuedAt))
    throw new Error("github-call-failed");
  return { state: text(field(value, "state")), position, enqueuedAt };
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
  const head = text(field(node, "headRefOid"));
  const entry = field(node, "mergeQueueEntry");
  if (state === "MERGED")
    return {
      kind: "merged",
      head,
      merged: text(field(field(node, "mergeCommit"), "oid")),
    };
  if (entry === null) return { kind: "left" };
  return { kind: "queued", entry: entryOf(entry) };
}

function mergedResult(pull: ReviewedPull, merged: string): SuccessfulMerge {
  return {
    number: pull.number,
    commit: pull.commit,
    updated: pull.commit,
    merged,
  };
}

async function enqueued(
  operation: Operation,
  target: Target,
): Promise<InQueue> {
  return retryGithub<InQueue>(operation, {
    action: async (attempt) => {
      const known =
        attempt > 0 ? await queueState(operation, target.id) : undefined;
      if (known !== undefined && known.kind !== "left") return known;
      const reply: unknown = JSON.parse(
        await operation.calls.gh(
          graphql(enqueueMutation, [
            `id=${target.id}`,
            `head=${target.pull.commit}`,
          ]),
        ),
      );
      const entry = field(
        field(field(reply, "data"), "enqueuePullRequest"),
        "mergeQueueEntry",
      );
      return { kind: "queued", entry: entryOf(entry) };
    },
  });
}

async function queueMerged(
  operation: Operation,
  view: { readonly pull: ReviewedPull; readonly state: MergedState },
): Promise<MergeResult> {
  if (view.state.head !== view.pull.commit)
    throw new Error("merged-other-commit");
  return finishedMerge(operation, mergedResult(view.pull, view.state.merged));
}

async function queuedOf(
  operation: Operation,
  view: { readonly target: Target; readonly state: InQueue },
): Promise<Queued | MergeResult> {
  if (view.state.kind === "merged")
    return queueMerged(operation, {
      pull: view.target.pull,
      state: view.state,
    });
  const started = view.state.entry.enqueuedAt;
  await writeRecord(operation.folder, {
    name: queueRecord,
    value: { commit: view.target.pull.commit, enqueuedAt: started },
  });
  return { ...view.target, started };
}

async function endedAttempt(
  operation: Operation,
  target: Target,
): Promise<Queued | undefined> {
  const record = await readRecord(operation.folder, queueRecord);
  const started = field(record, "enqueuedAt");
  if (field(record, "commit") !== target.pull.commit) return undefined;
  return typeof started === "number" ? { ...target, started } : undefined;
}

async function queueEntry(
  operation: Operation,
  pull: ReviewedPull,
): Promise<Queued | MergeResult> {
  const known = await knownMerge(operation, { ...pull, updated: pull.commit });
  if (known.merged !== undefined)
    return finishedMerge(operation, mergedResult(pull, known.merged));
  if (known.node === undefined) throw new Error("github-call-failed");
  const target = { pull, id: known.node };
  const state = await queueState(operation, target.id);
  if (state.kind !== "left") return queuedOf(operation, { target, state });
  const ended = await endedAttempt(operation, target);
  if (ended !== undefined) return ended;
  await checkedLocally(operation, pull);
  const ci = await waitForCi(operation, pull.commit);
  if (ci !== undefined) return ci;
  return queuedOf(operation, {
    target,
    state: await enqueued(operation, target),
  });
}

async function groupPage(
  operation: Operation,
  page: number,
): Promise<readonly unknown[]> {
  const reply: unknown = JSON.parse(
    await githubRead(operation, [
      "api",
      `${repositoryPath}/actions/runs?event=merge_group&per_page=100&page=${String(page)}`,
    ]),
  );
  return list(field(reply, "workflow_runs"));
}

function createdAt(run: unknown): number {
  return Date.parse(String(field(run, "created_at")));
}

async function groupHead(
  operation: Operation,
  wait: { readonly number: number; readonly started: number },
): Promise<string | undefined> {
  const branch = new RegExp(
    `^gh-readonly-queue/.+/pr-${String(wait.number)}-[0-9a-f]+$`,
  );
  for (let page = 1; page <= groupPageLimit; page += 1) {
    const runs = await groupPage(operation, page);
    const run = runs.find(
      (item) =>
        branch.test(String(field(item, "head_branch"))) &&
        createdAt(item) >= wait.started,
    );
    const head = field(run, "head_sha");
    if (typeof head === "string") return head;
    const oldest = runs.at(-1);
    if (runs.length < 100 || createdAt(oldest) < wait.started) return undefined;
  }
  return undefined;
}

async function removal(
  operation: Operation,
  queued: Queued,
): Promise<CiResult | QueueResult> {
  const { pull } = queued;
  await conflictChecked(operation, pull.commit);
  const head = await groupHead(operation, {
    number: pull.number,
    started: queued.started,
  });
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
  queued: Queued,
): Promise<QueueResult> {
  await operation.calls.gh(graphql(dequeueMutation, [`id=${queued.id}`]));
  const minutes = Math.round((Date.now() - queued.started) / 60_000);
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
  const { started } = queued;
  let shown = "";
  try {
    for (;;) {
      const state = await queueState(operation, queued.id);
      if (state.kind === "merged")
        return await queueMerged(operation, { pull: queued.pull, state });
      if (state.kind === "left") return await removal(operation, queued);
      shown = await shownEntry(operation, {
        started,
        entry: state.entry,
        shown,
      });
      if (Date.now() - started >= timing.queueLimitMilliseconds)
        return await timedOut(operation, queued);
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
    if (!("started" in entered)) return entered;
    return await settled(operation, entered);
  } catch (error) {
    return mergeRepair(operation, error);
  }
}
