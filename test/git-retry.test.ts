import assert from "node:assert/strict";
import { test } from "node:test";
import { retriedOperation } from "../src/daemon/git-retry.ts";
import type { Operation } from "../src/daemon/github-operation.ts";
import { withGitWaits } from "./github-git-fixture.ts";

interface Scripted {
  readonly operation: Operation;
  readonly invoked: readonly (readonly string[])[];
  readonly reasons: readonly string[];
}

interface Script {
  readonly signal?: AbortSignal;
  readonly noticed?: () => void;
}

function scripted(failures: readonly string[], script: Script = {}): Scripted {
  const remaining = [...failures];
  const invoked: (readonly string[])[] = [];
  const reasons: string[] = [];
  const refused = (): Promise<string> =>
    Promise.reject(new Error("unexpected-call"));
  const operation: Operation = {
    settings: { repository: "repository", gh: ["gh"], worktrees: "worktrees" },
    calls: {
      gh: refused,
      run: refused,
      git: (_directory, parts) => {
        invoked.push(parts);
        const detail = remaining.shift();
        if (detail === undefined) return Promise.resolve("done");
        return Promise.reject(
          Object.assign(new Error("git-call-failed"), { detail, status: NaN }),
        );
      },
    },
    target: "ticket/one",
    payload: {},
    signal: script.signal ?? new AbortController().signal,
    folder: "folder",
    observe: (report) => {
      reasons.push(report.reason);
      script.noticed?.();
      return Promise.resolve({ kind: "accepted" });
    },
  };
  return { operation, invoked, reasons };
}

const transientOutputs = [
  "fatal: Could not read from remote repository.",
  "git@github.com: Permission denied (publickey).",
  "kex_exchange_identification: read: Connection reset by peer",
  "ssh: connect to host github.com port 22: Connection timed out",
  "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
  "fatal: The remote end hung up unexpectedly",
  "fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF",
  "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502",
  "error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503",
];

for (const command of ["fetch", "push", "ls-remote"]) {
  for (const output of transientOutputs) {
    await test(`CLV-293 retries git ${command} after ${JSON.stringify(output)}`, () =>
      withGitWaits(async (waits) => {
        const git = scripted([output]);
        const result = await retriedOperation(git.operation).calls.git(
          "repository",
          [command, "origin"],
        );
        assert.equal(result, "done");
        assert.equal(git.invoked.length, 2);
        assert.deepEqual(waits, [5_000]);
      }));
  }
}

const lastingOutputs = [
  " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs",
  "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
  "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.",
];

for (const output of lastingOutputs) {
  await test(`CLV-293 fails git fetch at once after ${JSON.stringify(output)}`, () =>
    withGitWaits(async (waits) => {
      const git = scripted([output]);
      await assert.rejects(
        retriedOperation(git.operation).calls.git("repository", [
          "fetch",
          "origin",
        ]),
        { message: "git-call-failed", detail: output },
      );
      assert.equal(git.invoked.length, 1);
      assert.deepEqual(waits, []);
    }));
}

for (const parts of [
  ["merge", "--no-ff", "--no-edit", "main"],
  ["status", "--porcelain"],
  ["rev-parse", "HEAD"],
]) {
  await test(`CLV-293 keeps local git ${String(parts[0])} with no retry`, () =>
    withGitWaits(async (waits) => {
      const git = scripted(["fatal: Could not read from remote repository."]);
      await assert.rejects(
        retriedOperation(git.operation).calls.git("repository", parts),
        { message: "git-call-failed" },
      );
      assert.equal(git.invoked.length, 1);
      assert.deepEqual(waits, []);
    }));
}

await test("CLV-293 stops a git retry when the operation stops", () =>
  withGitWaits(async (waits) => {
    const stopping = new AbortController();
    stopping.abort();
    const git = scripted(["fatal: The remote end hung up unexpectedly"], {
      signal: stopping.signal,
    });
    await assert.rejects(
      retriedOperation(git.operation).calls.git("repository", [
        "push",
        "origin",
      ]),
      { name: "AbortError" },
    );
    assert.equal(git.invoked.length, 1);
    assert.deepEqual(waits, []);
  }));

await test("CLV-293 replaces the retry notice when a later git failure lasts", () =>
  withGitWaits(async (waits) => {
    const git = scripted([
      "fatal: The remote end hung up unexpectedly",
      " ! [rejected]        main -> main (non-fast-forward)",
    ]);
    await assert.rejects(
      retriedOperation(git.operation).calls.git("repository", [
        "push",
        "origin",
      ]),
      { message: "git-call-failed" },
    );
    assert.equal(git.invoked.length, 2);
    assert.deepEqual(waits, [5_000]);
    assert.deepEqual(git.reasons, ["git-network-retry", "in-progress"]);
  }));

await test("CLV-293 stops a git retry during its wait", async () => {
  const stopping = new AbortController();
  const git = scripted(["fatal: The remote end hung up unexpectedly"], {
    signal: stopping.signal,
    noticed: () => {
      setImmediate(() => {
        stopping.abort();
      });
    },
  });
  await assert.rejects(
    retriedOperation(git.operation).calls.git("repository", [
      "fetch",
      "origin",
    ]),
    { name: "AbortError" },
  );
  assert.equal(git.invoked.length, 1);
  assert.deepEqual(git.reasons, ["git-network-retry"]);
});
