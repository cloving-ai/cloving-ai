import { setImmediate } from "node:timers/promises";
import type {
  WatchCommandOutput,
  WatchCommandRequest,
} from "../src/cli/watch-pr-command.ts";
import { prObserver } from "../src/cli/watch-pr-observer.ts";

export const prRepositoryFixture = {
  host: "github.example",
  owner: "fixture",
  repository: "demo",
};
export const recordedPr = {
  number: 7,
  url: "https://github.example/fixture/demo/pull/7",
};
export function prBody(merged: unknown, number = 7): unknown {
  return {
    number,
    html_url: `https://github.example/fixture/demo/pull/${String(number)}`,
    base: {
      repo: {
        name: "demo",
        full_name: "fixture/demo",
        owner: { login: "fixture" },
        html_url: "https://github.example/fixture/demo",
      },
    },
    state: "closed",
    mergeable: true,
    merge_commit_sha: "test-merge-sha",
    merged,
  };
}
export function prOutput(merged: unknown, number = 7): WatchCommandOutput {
  return {
    status: 0,
    errorCode: null,
    stderr: "",
    stdout:
      "HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n" +
      JSON.stringify(prBody(merged, number)),
  };
}
export function observing(clock = fakePrClock()) {
  const attempts: {
    request: WatchCommandRequest;
    started: number;
    finish: (output: WatchCommandOutput) => void;
    reject: (error: Error) => void;
  }[] = [];
  const observer = prObserver({
    clock,
    repository: prRepositoryFixture,
    directory: "fixture-repository",
    command: ["fake-gh", "fixed-prefix"],
    execute: (request) =>
      new Promise((finish, reject) => {
        attempts.push({ request, started: clock.now(), finish, reject });
      }),
  });
  return { observer, attempts };
}
export async function settleObservation(): Promise<void> {
  await setImmediate();
}

export function fakePrClock() {
  let current = 1000;
  const scheduled = new Map<() => void, number>();
  return {
    now: () => current,
    after: (expired: () => void, milliseconds: number) => {
      scheduled.set(expired, current + milliseconds);
      return () => {
        scheduled.delete(expired);
      };
    },
    advance: (milliseconds: number) => {
      current += milliseconds;
      for (const [expired, at] of scheduled)
        if (at <= current) {
          scheduled.delete(expired);
          expired();
        }
    },
  };
}
