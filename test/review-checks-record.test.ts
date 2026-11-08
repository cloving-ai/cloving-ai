import assert from "node:assert/strict";
import { test } from "node:test";
import { recordOutput } from "../templates/review-checks/review-checks/review-record.mts";

const file = "/run/cloving/review-checks.jsonl";

function parsedLine(line: string): unknown {
  if (line === "") return null;
  const value: unknown = JSON.parse(line);
  return value;
}

function decision(name: string, answer: string) {
  return {
    name,
    kind: "new-rule",
    rule: name,
    shape: "Shape.",
    decision: answer,
    links: ["https://github.com/acme/demo/pull/641#discussion_r1"],
  };
}

async function recorded(commandArguments: readonly string[], input: string) {
  const appended: (readonly [string, string])[] = [];
  const output = await recordOutput({
    commandArguments,
    input,
    decidedAt: "2026-11-09T07:12:00Z",
    runId: "run-7",
    append: (path, text) => {
      appended.push([path, text]);
      return Promise.resolve();
    },
  });
  return { output, appended };
}

await test("CLV-316 review-checks-record appends one JSONL line for each decision", async () => {
  const input = JSON.stringify({
    decisions: [decision("first", "accept"), decision("second", "reject")],
  });
  const { output, appended } = await recorded([file], input);
  assert.deepEqual(output, {
    stdout: '{"recorded":2}\n',
    stderr: "",
    exitCode: 0,
  });
  assert.equal(appended.length, 1);
  const [path, text] = appended[0] ?? ["", ""];
  assert.equal(path, file);
  assert.deepEqual(
    text.split("\n").map((line) => parsedLine(line)),
    [
      Object.assign(decision("first", "accept"), {
        decidedAt: "2026-11-09T07:12:00Z",
        runId: "run-7",
      }),
      Object.assign(decision("second", "reject"), {
        decidedAt: "2026-11-09T07:12:00Z",
        runId: "run-7",
      }),
      null,
    ],
  );
});

await test("CLV-316 review-checks-record refuses bad arguments and bad input and appends nothing", async () => {
  for (const [commandArguments, input, message] of [
    [[], "{}", "Give the absolute decisions file as the only argument."],
    [
      ["relative.jsonl"],
      "{}",
      "Give the absolute decisions file as the only argument.",
    ],
    [[file], "not json", "The input has no valid decisions."],
    [
      [file],
      JSON.stringify({ decisions: [decision("Bad Name", "accept")] }),
      "The input has no valid decisions.",
    ],
    [
      [file],
      JSON.stringify({ decisions: [decision("first", "maybe")] }),
      "The input has no valid decisions.",
    ],
    [
      [file],
      JSON.stringify({ decisions: [] }),
      "The input has no valid decisions.",
    ],
  ] as const) {
    const { output, appended } = await recorded(commandArguments, input);
    assert.deepEqual(output, {
      stdout: "",
      stderr: `${message}\n`,
      exitCode: 1,
    });
    assert.deepEqual(appended, []);
  }
});
