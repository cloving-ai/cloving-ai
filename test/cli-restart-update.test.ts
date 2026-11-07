import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { record } from "../src/protocol.ts";
import type {
  RestartFailure,
  RestartMark,
  RestartPort,
} from "../src/restart-request.ts";
import { withHarness } from "./service-fixture.ts";

const identity = {
  version: "1.6.0",
  commit: "1111111111111111111111111111111111111111",
  startedAt: "2026-11-05T10:00:00.000Z",
};

interface Updating {
  readonly marks: RestartMark[];
  failure: RestartFailure;
}

function failingPort(updating: Updating): RestartPort {
  return {
    pending: () => Promise.resolve(updating.marks.at(-1)),
    request: (mark) => {
      updating.marks.push(mark);
      setTimeout(() => {
        updating.failure = {
          commandId: mark.commandId,
          requestedAt: mark.requestedAt,
          code: "restart-update-failed",
          step: "build",
          output: "> tsc\nerror TS2322: broken",
        };
        updating.marks.splice(0);
      }, 300);
      return Promise.resolve();
    },
    cancel: () => Promise.resolve("none"),
    unresumable: () => Promise.resolve([]),
    failure: () => Promise.resolve(updating.failure),
  };
}

function earlierFailure(commandId = "restart-earlier"): Updating {
  return {
    marks: [],
    failure: {
      commandId,
      requestedAt: 1,
      code: "restart-update-skipped",
      step: "clean",
      output: "?? a",
    },
  };
}

await test("CLV-306 cloving restart --update prints the step that failed and its output, and exits 1", () =>
  withHarness(async (harness) => {
    const updating = earlierFailure();
    await harness.start({ restart: failingPort(updating), ...identity });
    const result = await harness.cli([
      "restart",
      "--update",
      "--command-id",
      "restart-update",
    ]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "Restart pending: 0 runs active\n");
    assert.equal(
      result.stderr,
      [
        `restart-update-failed: The update stopped at step build. The service keeps running on commit ${identity.commit}.`,
        "    > tsc",
        "    error TS2322: broken",
        "Command ID: restart-update",
        "",
      ].join("\n"),
    );
    assert.equal(updating.marks.length, 0);
  }));

await test("CLV-306 cloving restart --update --json prints the failed step and output as fields", () =>
  withHarness(async (harness) => {
    const updating = earlierFailure();
    await harness.start({ restart: failingPort(updating), ...identity });
    const result = await harness.cli([
      "restart",
      "--update",
      "--json",
      "--command-id",
      "restart-json",
    ]);
    assert.equal(result.status, 1, result.stderr);
    const [pending, failed] = result.stdout
      .trim()
      .split("\n")
      .map((line) => record(JSON.parse(line)));
    assert.equal(record(pending?.["restart"])?.["update"], true);
    assert.equal(failed?.["code"], "restart-update-failed");
    assert.equal(failed["commandId"], "restart-json");
    assert.equal(failed["step"], "build");
    assert.equal(failed["output"], "> tsc\nerror TS2322: broken");
  }));

await test("CLV-306 a retry with the command ID of a failed update waits for its own result", () =>
  withHarness(async (harness) => {
    const updating = earlierFailure("restart-retry");
    await harness.start({ restart: failingPort(updating), ...identity });
    const result = await harness.cli([
      "restart",
      "--update",
      "--command-id",
      "restart-retry",
    ]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /The update stopped at step build\./);
    assert.equal(updating.marks.length, 0);
  }));

const codeOf = (argumentsList: readonly string[]): unknown =>
  record(parseInvocation(argumentsList))?.["code"];

await test("CLV-306 cloving restart accepts --update and refuses it with --cancel", () => {
  assert.equal(
    record(parseInvocation(["restart", "--update"]))?.["update"],
    true,
  );
  assert.equal(record(parseInvocation(["restart"]))?.["update"], false);
  assert.equal(
    codeOf(["restart", "--cancel", "--update"]),
    "unexpected-option",
  );
  assert.match(String(commandUsage["restart"]), /\[--update\]/);
  assert.match(String(commandUsage["restart"]), /npm ci --ignore-scripts/);
});
