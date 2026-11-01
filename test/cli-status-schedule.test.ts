import assert from "node:assert/strict";
import { test } from "node:test";
import { failed, result } from "../src/service/replies.ts";
import {
  withHarness,
  parsed,
  call,
  field,
  items,
  startedRun,
} from "./service-fixture.ts";

await test("CLV-247 status shows a declared 300-second schedule", () =>
  withHarness(async (harness) => {
    await harness.start({
      schedule: (parameters) => {
        assert.deepEqual(parameters, { action: "list" });
        return Promise.resolve(
          result("schedules", {
            schedules: [
              {
                workflowId: "review-queue",
                everySeconds: 300,
                state: "active",
                failuresInRow: 0,
                nextAt: 300000,
                stoppedAt: null,
              },
            ],
          }),
        );
      },
    });
    const plain = await harness.cli(["status"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(
      plain.stdout,
      /^Schedule review-queue: every 300 s, active, next run at 1970-01-01T00:05:00.000Z, 0 failures in a row$/m,
    );
    const json = await harness.cli(["status", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(parsed(json)["schedules"], [
      {
        workflowId: "review-queue",
        everySeconds: 300,
        state: "active",
        failuresInRow: 0,
        nextAt: 300000,
        stoppedAt: null,
      },
    ]);
  }));

await test("CLV-247 status reports active, paused and stopped schedules after each poll", () =>
  withHarness(async (harness) => {
    let state = "active";
    await harness.start({
      schedule: () =>
        Promise.resolve(
          result("schedules", {
            schedules: [
              {
                workflowId: "review-queue",
                everySeconds: 300,
                state,
                failuresInRow: state === "stopped" ? 3 : 0,
                nextAt: state === "active" ? 300000 : null,
                stoppedAt: state === "stopped" ? 600000 : null,
                activeRunId: "private-extra-field",
              },
            ],
          }),
        ),
    });
    for (state of ["active", "paused", "stopped"]) {
      const json = await harness.cli(["status", "--json"]);
      assert.equal(json.status, 0, json.stderr);
      assert.deepEqual(parsed(json)["schedules"], [
        {
          workflowId: "review-queue",
          everySeconds: 300,
          state,
          failuresInRow: state === "stopped" ? 3 : 0,
          nextAt: state === "active" ? 300000 : null,
          stoppedAt: state === "stopped" ? 600000 : null,
        },
      ]);
      const plain = await harness.cli(["status"]);
      assert.equal(plain.status, 0, plain.stderr);
      assert.ok(plain.stdout.includes(`every 300 s, ${state}`));
      assert.equal(plain.stdout.includes("next run at"), state === "active");
      assert.equal(
        plain.stdout.includes(
          "stopped at 1970-01-01T00:10:00.000Z, 3 failures in a row",
        ),
        state === "stopped",
      );
    }
  }));

await test("CLV-247 status omits absent schedules and distinguishes an unavailable scheduler", async () => {
  for (const [schedule, expected] of [
    [undefined, undefined],
    [() => Promise.resolve(result("schedules", { schedules: [] })), undefined],
    [
      () => Promise.resolve(failed("schedules-unavailable", {})),
      { status: "unavailable" },
    ],
  ] as const) {
    await withHarness(async (harness) => {
      await harness.start(schedule === undefined ? {} : { schedule });
      const json = await harness.cli(["status", "--json"]);
      assert.equal(json.status, 0, json.stderr);
      const value = parsed(json)["schedules"];
      assert.deepEqual(value, expected);
      const plain = await harness.cli(["status"]);
      assert.equal(plain.status, 0, plain.stderr);
      assert.equal(
        plain.stdout.includes("Schedules: unavailable"),
        value !== undefined,
      );
    });
  }
});

await test("CLV-247 scheduled admissions have a slot in summary, detail and text across restart", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const scheduledId = await startedRun(harness, {
      service,
      commandId: "schedule:develop:12",
    });
    const manualId = await startedRun(harness, {
      service,
      commandId: "manual",
    });
    await service.close();
    await harness.start();
    const listed = await call(harness, { operation: "status", parameters: {} });
    for (const [runId, mark] of [
      [scheduledId, { slot: 12 }],
      [manualId, undefined],
    ] as const) {
      const summary = items(listed["runs"]).find(
        (run) => field(run, "runId") === runId,
      );
      assert.deepEqual(field(summary, "scheduled"), mark);
      const detail = await call(harness, {
        operation: "status",
        parameters: { runId },
      });
      assert.deepEqual(field(detail["run"], "scheduled"), mark);
    }
    const plain = await harness.cli(["status"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(
      plain.stdout,
      new RegExp(`^  ${scheduledId} .*scheduled 12$`, "m"),
    );
    assert.doesNotMatch(
      plain.stdout.split("\n").find((line) => line.includes(manualId)) ?? "",
      /scheduled/,
    );
    const detail = await harness.cli(["status", scheduledId]);
    assert.equal(detail.status, 0, detail.stderr);
    assert.match(detail.stdout, /^scheduled 12$/m);
  }));

await test("CLV-247 unrelated and malformed admission command IDs do not mark a run", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    for (const commandId of [
      "schedule:other:12",
      "schedule:develop:12:extra",
      "schedule:develop:-1",
      "schedule:develop:1.2",
      "schedule:develop:12x",
      "schedule:develop:",
      "schedule:develop:9007199254740992",
    ]) {
      const runId = await startedRun(harness, { service, commandId });
      const detail = await call(harness, {
        operation: "status",
        parameters: { runId },
      });
      assert.equal(field(detail["run"], "scheduled"), undefined, commandId);
    }
  }));
