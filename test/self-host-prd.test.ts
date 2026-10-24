import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeGh, ghState } from "./github-worker-fixture.ts";
import {
  ended,
  field,
  reached,
  scene,
  withoutChildren,
  type Asked,
} from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";

const writer = `
import { writeFileSync } from "node:fs";
for await (const chunk of process.stdin) chunk.toString();
writeFileSync("cloving-prd-draft.md", "# Run costs\\n\\n## Problem\\nShow the cost of a run.\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "Draft ready" }) + "\\n");
`;

function commands(
  root: string,
  options: { readonly refuseHandoff?: true },
): { readonly state: string; readonly script: string } {
  const state = join(root, "gh-state.json");
  const script = join(root, "fake-gh.mjs");
  writeFileSync(state, ghState({ scores: [] }));
  writeFileSync(
    script,
    fakeGh.replace(
      "number: state.issues.length + 1",
      'repository: "acme/demo", number: state.issues.length + 1',
    ),
  );
  writeFileSync(
    join(root, "fake-board.mjs"),
    options.refuseHandoff
      ? "process.exit(3);"
      : 'process.stdout.write("# New PRD\\n\\nGitHub issue: acme/demo#" + process.argv.at(-1) + " (open)\\n");',
  );
  return { state, script };
}

async function prdRun(
  privateTexts: string | undefined,
  options: { readonly refuseHandoff?: true } = {},
): Promise<{
  readonly run: unknown;
  readonly state: string;
  readonly directory: string;
  readonly targets: readonly unknown[];
}> {
  const work = await scene(writer);
  const { state, script } = commands(work.root, options);
  const daemon = await work.start({
    CLOVING_PRIVATE_TEXTS: privateTexts,
    CLOVING_GH_COMMAND: JSON.stringify([process.execPath, script]),
    FAKE_GH_STATE: state,
    FAKE_GH_ORIGIN: work.origin,
  });
  const asked: Asked = (operation, parameters) =>
    call(
      { runtimeDirectory: work.runtimeDirectory },
      { operation, parameters },
    );
  const admitted = await asked("run", {
    workflowId: "develop-prd",
    source: "prompt",
    submission: { prompt: "Show run costs" },
    commandId: "prd-1",
  });
  const runId = String(admitted["runId"]);
  const run = await reached(async () => {
    const run = field(await asked("status", { runId }), "run");
    return ["blocked", "completed", "failed"].includes(
      String(field(run, "state")),
    )
      ? run
      : undefined;
  });
  const listed = field(await asked("status", {}), "runs");
  assert.ok(Array.isArray(listed));
  const targets: unknown[] = listed.filter(
    (entry: unknown) => field(entry, "workflowId") === "develop-issue",
  );
  assert.equal(await ended(daemon), 0);
  return { run, state, directory: work.directory, targets };
}

function issueCount(state: string): unknown {
  const saved: unknown = JSON.parse(readFileSync(state, "utf8"));
  return field(field(saved, "issues"), "length");
}

await test("CLV-075 a started daemon preserves the absent operator list and refuses the post", () =>
  withoutChildren(async () => {
    const result = await prdRun(undefined);
    assert.deepEqual(field(result.run, "outcome"), {
      kind: "blocked",
      reason: "private-texts-not-set",
    });
    const results = readdirSync(join(result.directory, "github")).flatMap(
      (folder) => {
        const path = join(result.directory, "github", folder, "result.json");
        return existsSync(path) ? [readFileSync(path, "utf8")] : [];
      },
    );
    assert.ok(
      results.some((record) => record.includes("private-texts-not-set")),
    );
    assert.equal(issueCount(result.state), 0);
    assert.deepEqual(result.targets, []);
    assert.equal(readdirSync(join(result.directory, "worktrees")).length, 1);
  }));

await test("CLV-169 a refused compiled PRD handoff queues the issue and retains its promotion and refusal in status", () =>
  withoutChildren(async () => {
    const result = await prdRun('["private organization"]', {
      refuseHandoff: true,
    });
    const saved: unknown = JSON.parse(readFileSync(result.state, "utf8"));
    assert.deepEqual(field(field(field(saved, "issues"), 0), "labels"), [
      "cloving: ready",
    ]);
    assert.deepEqual(result.targets, []);
    assert.equal(field(result.run, "state"), "completed");
    assert.deepEqual(field(result.run, "outcome"), {
      kind: "handoff_requested",
      promotionId: "issue-1",
      reason: "handoff-input-refused",
    });
    assert.deepEqual(field(result.run, "budget"), { limit: 8, spent: 7 });
    assert.deepEqual(readdirSync(join(result.directory, "worktrees")), []);
  }));

await test("CLV-169 compiled PRD creates an issue and starts exactly one develop-issue run for its number", () =>
  withoutChildren(async () => {
    const result = await prdRun('["private organization"]');
    assert.equal(result.targets.length, 1);
    assert.deepEqual(field(result.targets[0], "input"), { ticket: "1" });
    assert.equal(
      field(result.targets[0], "parentRunId"),
      field(result.run, "runId"),
    );
    assert.equal(field(result.run, "state"), "completed");
    assert.deepEqual(field(result.run, "outcome"), {
      kind: "handoff_requested",
      promotionId: "issue-1",
      reason: null,
    });
    assert.equal(issueCount(result.state), 1);
    assert.deepEqual(field(result.run, "budget"), { limit: 8, spent: 6 });
  }));
