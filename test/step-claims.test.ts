import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseStepClaims, type ClaimWorld } from "../src/host/step-claims.ts";

interface Recorded {
  readonly eventType: string;
  readonly correlationId?: string;
}

function world(script: {
  readonly statuses: Readonly<Record<string, string>>;
  readonly events?: Readonly<Record<string, readonly Recorded[]>>;
  readonly pageSize?: number;
}): ClaimWorld & { readonly reads: string[] } {
  const reads: string[] = [];
  const size = script.pageSize ?? 1000;
  return {
    reads,
    runs: {
      get: (runId) => {
        reads.push(`run ${runId}`);
        const status = script.statuses[runId];
        return status === undefined
          ? Promise.reject(new Error("the run record is not stored"))
          : Promise.resolve({ status });
      },
    },
    events: {
      list: ({ runId, pagination }) => {
        const from = Number(pagination.cursor ?? "0");
        reads.push(`events ${runId} ${String(from)}`);
        const all = script.events?.[runId] ?? [];
        const more = from + size < all.length;
        return Promise.resolve({
          data: all.slice(from, from + size),
          cursor: more ? String(from + size) : null,
          hasMore: more,
        });
      },
    },
  };
}

function withData<Result>(
  files: Readonly<Record<string, string>>,
  action: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = mkdtempSync(join(tmpdir(), "cloving-claims-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  return action(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function names(directory: string, folder: string): readonly string[] {
  const path = join(directory, folder);
  return existsSync(path) ? readdirSync(path).sort() : [];
}

function stepRecords(directory: string): readonly unknown[] {
  return names(directory, "steps").map((name): unknown =>
    JSON.parse(readFileSync(join(directory, "steps", name), "utf8")),
  );
}

const started = { eventType: "step_started", correlationId: "step_A" };
const failed = { eventType: "step_failed", correlationId: "step_A" };
const other = { eventType: "step_completed", correlationId: "step_B" };
const runEvents = [{ eventType: "run_created" }, { eventType: "run_started" }];

await test("CLV-056 the claim release keeps each claim of a run at an end, of a run with no stored record and of a step whose World event is stored, and it reads a data directory with no claim folder", () =>
  withData(
    {
      ".locks/steps/wrun_1-step_A.created": "",
      ".locks/steps/wrun_1-step_A.terminal": "",
      ".locks/steps/wrun_2-step_A.created": "",
      ".locks/steps/wrun_3-step_A.created": "",
      ".locks/steps/wrun_3-step_A.terminal": "",
      ".locks/steps/wrun_3-step_A.created.tmp.01ABC": "",
      ".locks/steps/notes.txt": "",
      "steps/wrun_3-step_A.json": JSON.stringify({ status: "failed" }),
    },
    async (directory) => {
      const fake = world({
        statuses: { wrun_1: "completed", wrun_3: "running" },
        events: { wrun_3: [...runEvents, started, failed] },
        pageSize: 2,
      });
      assert.deepEqual(await releaseStepClaims(directory, fake), []);
      assert.equal(names(directory, ".locks/steps").length, 7);
      assert.deepEqual(fake.reads, [
        "run wrun_1",
        "run wrun_2",
        "run wrun_3",
        "events wrun_3 0",
        "events wrun_3 2",
      ]);
      assert.deepEqual(
        await releaseStepClaims(join(directory, "absent"), fake),
        [],
      );
    },
  ));

await test("CLV-056 the claim release removes a start claim with no World event together with its step record, and it removes an end claim with no end event and opens its step record again", () =>
  withData(
    {
      ".locks/steps/wrun_1-step_A.created": "",
      ".locks/steps/wrun_2-step_A.created": "",
      ".locks/steps/wrun_2-step_A.terminal": "",
      ".locks/steps/wrun_2-step_B.terminal": "",
      ".locks/steps/wrun_3-step_A.terminal": "",
      ".locks/steps/wrun_4-step_A.terminal": "",
      "steps/wrun_1-step_A.json": JSON.stringify({ status: "pending" }),
      "steps/wrun_2-step_A.json": JSON.stringify({
        status: "completed",
        attempt: 1,
        output: "a result",
        error: null,
        completedAt: "2026-10-13T00:00:00.000Z",
      }),
      "steps/wrun_2-step_B.json": JSON.stringify({ status: "completed" }),
      "steps/wrun_3-step_A.json": JSON.stringify({ status: "running" }),
    },
    async (directory) => {
      const fake = world({
        statuses: {
          wrun_1: "running",
          wrun_2: "running",
          wrun_3: "pending",
          wrun_4: "running",
        },
        events: {
          wrun_1: runEvents,
          wrun_2: [started, other],
          wrun_3: [started],
          wrun_4: [started],
        },
      });
      assert.deepEqual(await releaseStepClaims(directory, fake), [
        "wrun_1-step_A.created",
        "wrun_2-step_A.terminal",
        "wrun_3-step_A.terminal",
        "wrun_4-step_A.terminal",
      ]);
      assert.deepEqual(names(directory, ".locks/steps"), [
        "wrun_2-step_A.created",
        "wrun_2-step_B.terminal",
      ]);
      assert.deepEqual(names(directory, "steps"), [
        "wrun_2-step_A.json",
        "wrun_2-step_B.json",
        "wrun_3-step_A.json",
      ]);
      assert.deepEqual(stepRecords(directory), [
        { status: "running", attempt: 1 },
        { status: "completed" },
        { status: "running" },
      ]);
    },
  ));
