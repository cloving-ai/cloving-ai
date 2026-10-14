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

async function prdRun(privateTexts: string | undefined): Promise<{
  readonly run: unknown;
  readonly state: string;
  readonly directory: string;
}> {
  const work = await scene(writer);
  const state = join(work.root, "gh-state.json");
  const script = join(work.root, "fake-gh.mjs");
  writeFileSync(state, ghState({ scores: [] }));
  writeFileSync(script, fakeGh);
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
  assert.equal(await ended(daemon), 0);
  return { run, state, directory: work.directory };
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
    assert.equal(readdirSync(join(result.directory, "worktrees")).length, 1);
  }));

await test("CLV-075 the compiled PRD workflow posts an issue and completes without a review gate", () =>
  withoutChildren(async () => {
    const result = await prdRun('["private organization"]');
    assert.equal(field(result.run, "state"), "completed");
    assert.deepEqual(field(result.run, "outcome"), {
      kind: "handoff_requested",
      reason: null,
    });
    assert.equal(issueCount(result.state), 1);
    assert.deepEqual(field(result.run, "budget"), { limit: 8, spent: 5 });
    assert.deepEqual(readdirSync(join(result.directory, "worktrees")), []);
  }));
