import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeGh, ghState } from "./github-worker-fixture.ts";
import {
  ended,
  fakeClaude,
  field,
  git,
  reached,
  scene,
  withoutChildren,
  type Asked,
  type Scene,
} from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function pulls(file: string): readonly Readonly<Record<string, unknown>>[] {
  const listed = record(JSON.parse(readFileSync(file, "utf8")))["prs"];
  return Array.isArray(listed)
    ? listed.map((item: unknown) => record(item))
    : [];
}

function issueState(scores: readonly number[]): string {
  return ghState({
    scores,
    labels: [
      { repository: "acme/demo", name: "cloving: ready", color: "ededed" },
    ],
    issues: [
      {
        repository: "acme/demo",
        number: 900,
        state: "open",
        body: "Original body.",
        labels: ["cloving: ready"],
      },
    ],
  });
}

function assertIssueLabels(file: string, labels: readonly string[]): void {
  assert.deepEqual(record(JSON.parse(readFileSync(file, "utf8")))["issues"], [
    {
      repository: "acme/demo",
      number: 900,
      labels,
      state: labels.length === 0 ? "closed" : "open",
      body:
        labels.length === 0
          ? "Original body.\n\n## Cloving status\nCompleted in pull request #1.\n"
          : "Original body.",
      ...(labels.length === 0 ? { state_reason: "completed" } : {}),
    },
  ]);
}

function githubEnvironment(
  work: Pick<Scene, "root" | "origin">,
): Readonly<Record<string, string>> {
  return {
    CLOVING_GH_COMMAND: JSON.stringify([
      process.execPath,
      join(work.root, "fake-gh.mjs"),
    ]),
    CLOVING_CHECK_COMMAND: JSON.stringify([process.execPath, "-e", ""]),
    CLOVING_PRIVATE_TEXTS: JSON.stringify(["no such text"]),
    FAKE_GH_STATE: join(work.root, "gh-state.json"),
    FAKE_GH_ORIGIN: work.origin,
  };
}

async function issueStarted(asked: Asked): Promise<string> {
  const admitted = await asked("run", {
    workflowId: "develop-issue",
    source: "ticket",
    submission: { ticket: "CLV-900" },
    commandId: "c-1",
  });
  return String(admitted["runId"]);
}

function completion(
  asked: Asked,
  runId: string,
): Promise<Readonly<Record<string, unknown>>> {
  return reached(async () => {
    const shown = record(field(await asked("status", { runId }), "run"));
    return shown["state"] === "completed" ? shown : undefined;
  });
}

async function issueRun(): Promise<void> {
  const work = await scene(
    fakeClaude.replace(
      "I added the file ticket-work.txt.",
      "I added the file ticket-work.txt.\\nTicket status: complete",
    ),
  );
  const { root, repository, origin, runtimeDirectory } = work;
  const stateFile = join(root, "gh-state.json");
  writeFileSync(join(root, "fake-gh.mjs"), fakeGh);
  writeFileSync(stateFile, issueState([5]));
  const before = git(repository, ["rev-parse", "HEAD"]);
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  const daemon = await work.start(githubEnvironment(work));
  const run = await completion(asked, await issueStarted(asked));
  assert.deepEqual(field(run, "budget"), { limit: 20, spent: 7 });
  assertIssueLabels(stateFile, []);
  const [pull] = pulls(stateFile);
  assert.deepEqual(
    [pull?.["state"], pull?.["title"], pull?.["base"]],
    ["MERGED", "CLV-900: Add the ticket work", "main"],
  );
  assert.match(String(pull?.["body"]), /^Refs acme\/demo#900\n\n/);
  assert.equal(
    git(origin, ["show", `${String(pull?.["mergedHead"])}:ticket-work.txt`]),
    "the last line of CLV-900\n",
  );
  assert.deepEqual(
    [
      git(origin, ["branch", "--list", "cloving/*"]),
      git(repository, ["branch", "--list", "cloving/*"]),
      existsSync(
        join(
          work.directory,
          "worktrees",
          String(pull?.["head"]).slice("cloving/".length),
        ),
      ),
      git(repository, ["rev-parse", "HEAD"]),
      git(repository, ["status", "--short"]),
    ],
    ["", "", false, before, ""],
  );
  assert.equal(await ended(daemon), 0);
}

await test("CLV-063 the workflow develop-issue makes a work tree from origin, asks the Claude worker for one turn, opens a pull request that references the issue and closes it after the merge, merges it at the Greptile score 5/5, and removes the branches and the work tree", () =>
  withoutChildren(issueRun));

function reviewRead(stateFile: string): true | undefined {
  const calls = record(JSON.parse(readFileSync(stateFile, "utf8")))["calls"];
  const read =
    Array.isArray(calls) &&
    calls.some((item: unknown) => String(item).includes("issues/1/comments"));
  return read ? true : undefined;
}

async function restartedReview(): Promise<void> {
  const work = await scene(
    fakeClaude.replace(
      "I added the file ticket-work.txt.",
      "I added the file ticket-work.txt.\\nTicket status: complete",
    ),
  );
  const stateFile = join(work.root, "gh-state.json");
  writeFileSync(join(work.root, "fake-gh.mjs"), fakeGh);
  writeFileSync(stateFile, issueState([]));
  const asked: Asked = (operation, parameters) =>
    call(
      { runtimeDirectory: work.runtimeDirectory },
      { operation, parameters },
    );
  const first = await work.start(githubEnvironment(work));
  const runId = await issueStarted(asked);
  await reached(() => Promise.resolve(reviewRead(stateFile)));
  assertIssueLabels(stateFile, ["cloving: in progress"]);
  assert.equal(await ended(first), 0);
  const state = record(JSON.parse(readFileSync(stateFile, "utf8")));
  writeFileSync(stateFile, JSON.stringify({ ...state, scores: [5] }));
  const second = await work.start(githubEnvironment(work));
  await completion(asked, runId);
  assertIssueLabels(stateFile, []);
  assert.deepEqual(
    pulls(stateFile).map((pull) => pull["state"]),
    ["MERGED"],
  );
  assert.equal(await ended(second), 0);
}

await test("CLV-067 a stop and a start of the daemon while the run waits for the Greptile review do not end the run, and the new daemon continues the wait and merges the pull request at the score 5/5", () =>
  withoutChildren(restartedReview));

async function restartedStatus(): Promise<void> {
  const work = await scene(
    fakeClaude.replace(
      "I added the file ticket-work.txt.",
      "Changed.\\nRemaining:\\n- Test recovery.\\nTicket status: partial",
    ),
  );
  const stateFile = join(work.root, "gh-state.json");
  const marker = join(work.root, "status-paused");
  writeFileSync(join(work.root, "fake-gh.mjs"), fakeGh);
  writeFileSync(stateFile, issueState([5]));
  const paused = join(work.root, "paused-gh.mjs");
  writeFileSync(
    paused,
    `
import { writeFileSync } from "node:fs";
if (process.argv.includes("PATCH")) {
  writeFileSync(${JSON.stringify(marker)}, "");
  await new Promise(() => { setInterval(() => undefined, 1000); });
}
await import("./fake-gh.mjs");
`,
  );
  const asked: Asked = (operation, parameters) =>
    call(
      { runtimeDirectory: work.runtimeDirectory },
      { operation, parameters },
    );
  const environment = githubEnvironment(work);
  const first = await work.start({
    ...environment,
    CLOVING_GH_COMMAND: JSON.stringify([process.execPath, paused]),
  });
  const runId = await issueStarted(asked);
  await reached(() => Promise.resolve(existsSync(marker) ? true : undefined));
  assert.equal(pulls(stateFile)[0]?.["state"], "MERGED");
  assertIssueLabels(stateFile, ["cloving: in progress"]);
  assert.equal(await ended(first), 0);
  const second = await work.start(environment);
  const run = await completion(asked, runId);
  assert.equal(field(field(run, "outcome"), "ticketStatus"), "partial");
  const state = record(JSON.parse(readFileSync(stateFile, "utf8")));
  const issue = record(field(state["issues"], 0));
  assert.equal(issue["state"], "open");
  assert.deepEqual(issue["labels"], ["cloving: ready"]);
  assert.equal(
    issue["body"],
    "Original body.\n\n## Cloving status\n- Pull request #1: partial. Remaining: Test recovery.\n",
  );
  const calls = state["calls"];
  assert.ok(Array.isArray(calls));
  assert.equal(
    calls.filter(
      (call: unknown) => Array.isArray(call) && call.includes("PATCH"),
    ).length,
    1,
  );
  assert.equal(await ended(second), 0);
}

await test("CLV-123 restart after merge and before issue status writes the partial result once", () =>
  withoutChildren(restartedStatus));
