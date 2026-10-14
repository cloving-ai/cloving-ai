import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeGh, ghState } from "./github-worker-fixture.ts";
import {
  ended,
  field,
  git,
  reached,
  scene,
  withoutChildren,
  type Asked,
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

async function issueRun(): Promise<void> {
  const work = await scene();
  const { root, repository, origin, runtimeDirectory } = work;
  const stateFile = join(root, "gh-state.json");
  writeFileSync(join(root, "fake-gh.mjs"), fakeGh);
  writeFileSync(stateFile, ghState({ scores: [5] }));
  const before = git(repository, ["rev-parse", "HEAD"]);
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  const daemon = await work.start({
    CLOVING_GH_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fake-gh.mjs"),
    ]),
    CLOVING_CHECK_COMMAND: JSON.stringify([process.execPath, "-e", ""]),
    CLOVING_PRIVATE_TEXTS: JSON.stringify(["no such text"]),
    FAKE_GH_STATE: stateFile,
    FAKE_GH_ORIGIN: origin,
  });
  const admitted = await asked("run", {
    workflowId: "develop-issue",
    source: "ticket",
    submission: { ticket: "CLV-900" },
    commandId: "c-1",
  });
  const runId = String(admitted["runId"]);
  const run = await reached(async () => {
    const shown = field(await asked("status", { runId }), "run");
    return field(shown, "state") === "completed" ? shown : undefined;
  });
  assert.deepEqual(field(run, "budget"), { limit: 16, spent: 5 });
  const [pull] = pulls(stateFile);
  assert.deepEqual(
    [pull?.["state"], pull?.["title"], pull?.["base"]],
    ["MERGED", "CLV-900: Add the ticket work", "main"],
  );
  assert.match(String(pull?.["body"]), /^Closes acme\/demo#900\n\n/);
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

await test("CLV-063 the workflow develop-issue makes a work tree from origin, asks the Claude worker for one turn, opens a pull request that closes the issue, merges it at the Greptile score 5/5, and removes the branches and the work tree", () =>
  withoutChildren(issueRun));
