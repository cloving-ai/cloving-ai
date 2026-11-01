import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
import { fakeGh, ghState, statusBody } from "./github-worker-fixture.ts";
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
          ? statusBody("Original body.", {
              partialRuns: [],
              completedPullRequest: 1,
            })
          : "Original body.",
      ...(labels.length === 0 ? { state_reason: "completed" } : {}),
    },
  ]);
}

function githubEnvironment(
  work: Pick<Scene, "root" | "origin">,
): Readonly<Record<string, string>> {
  return {
    CLOVING_PHONE_RELAY: "off",
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
    workflowId: "develop",
    source: "ticket",
    submission: { ticket: "CLV-900" },
    commandId: "c-1",
  });
  assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
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
  await writeDeclaredWorkflow(repository);
  const stateFile = join(root, "gh-state.json");
  writeFileSync(join(root, "fake-gh.mjs"), fakeGh);
  writeFileSync(stateFile, issueState([5]));
  const before = git(repository, ["rev-parse", "HEAD"]);
  const untouched = git(repository, ["status", "--short"]);
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  const daemon = await work.start(githubEnvironment(work));
  const run = await completion(asked, await issueStarted(asked));
  assert.deepEqual(field(run, "budget"), { limit: 27, spent: 7 });
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
    ["", "", false, before, untouched],
  );
  assert.equal(await ended(daemon), 0);
}

await test("CLV-262 a declared template workflow runs GitHub effects, merges the issue change and cleans its worktree", () =>
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
  await writeDeclaredWorkflow(work.repository);
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

await test("CLV-262 a declared template workflow resumes its GitHub review after daemon restart", () =>
  withoutChildren(restartedReview));
