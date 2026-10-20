import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitReview } from "../src/daemon/github-methods.ts";
import type { Operation } from "../src/daemon/github-operation.ts";

export const reviewCommit = "a".repeat(40);
export const reviewSummary = `Last reviewed commit: https://github.com/acme/demo/commit/${reviewCommit}`;
const comments = JSON.stringify([
  {
    user: { login: "greptile-apps[bot]" },
    body: `<!-- greptile_confidence_score:5 -->\n${reviewSummary}`,
  },
]);

interface ReviewPlan {
  readonly requestFailures?: number;
  readonly reviewAfterRequests?: number;
  readonly readFailure?: "all" | "findings" | "malformed";
}

interface ReviewScene {
  readonly folder: string;
  readonly requests: number[];
  readonly reads: number[];
  readonly now: () => number;
  readonly wait: () => Promise<unknown>;
}

function refused(status: number): Promise<never> {
  return Promise.reject(
    Object.assign(new Error("private message token"), {
      detail: "private diagnostic token",
      status,
    }),
  );
}

interface ReviewState {
  now: number;
  accepted: number;
  readonly requests: number[];
  readonly reads: number[];
}

function reviewCalls(
  plan: ReviewPlan,
  state: ReviewState,
): Operation["calls"]["gh"] {
  const requestFailures = plan.requestFailures ?? 0;
  const reviewAfterRequests = plan.reviewAfterRequests ?? Infinity;
  return (parts) => {
    if (parts[0] === "pr") {
      state.requests.push(state.now);
      if (state.requests.length <= requestFailures) return refused(403);
      state.accepted++;
      return Promise.resolve("");
    }
    state.reads.push(state.now);
    if (plan.readFailure === "all") return refused(503);
    if (parts[1]?.includes("pulls/")) {
      if (plan.readFailure === "findings") return refused(503);
      return Promise.resolve("[]");
    }
    if (plan.readFailure === "malformed")
      return Promise.resolve("private token");
    return Promise.resolve(
      state.accepted >= reviewAfterRequests ? comments : "[]",
    );
  };
}

export async function withReview<Result>(
  plan: ReviewPlan,
  use: (scene: ReviewScene) => Promise<Result>,
): Promise<Result> {
  const folder = mkdtempSync(join(tmpdir(), "cloving-review-retry-"));
  const state: ReviewState = { now: 0, accepted: 0, requests: [], reads: [] };
  const clock = {
    now: () => state.now,
    sleep: (milliseconds: number, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      state.now += milliseconds;
      return Promise.resolve();
    },
  };
  const operation: Operation = {
    settings: { repository: folder, worktrees: folder, gh: ["gh"] },
    calls: {
      gh: reviewCalls(plan, state),
      git: () => Promise.reject(new Error("unexpected-git")),
      run: () => Promise.reject(new Error("unexpected-run")),
    },
    target: "ticket-review",
    payload: { number: 1, commit: reviewCommit },
    signal: new AbortController().signal,
    folder,
  };
  try {
    return await use({
      folder,
      requests: state.requests,
      reads: state.reads,
      now: clock.now,
      wait: () => waitReview(operation, clock),
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
