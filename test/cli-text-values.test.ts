import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { digestOf, waitingGate, withHarness } from "./service-fixture.ts";

const binding = [
  "--expected-revision",
  "1",
  "--generation",
  "1",
  "--subject-digest",
  `sha256:${"1".repeat(64)}`,
];

await test("CLV-008 a prompt or an answer text that starts with a hyphen is taken as the value", () => {
  const prompt = "-1 is returned by parse(); correct it";
  const run = parseInvocation(["run", "develop", "--prompt", prompt]);
  assert.deepEqual(
    [run.kind, Reflect.get(run, "source")],
    ["run", { kind: "prompt", text: prompt }],
  );
  const dashes = parseInvocation(["run", "develop", "--prompt", "--fix all"]);
  assert.deepEqual(Reflect.get(dashes, "source"), {
    kind: "prompt",
    text: "--fix all",
  });
  const answer = parseInvocation(["answer", "Q1", "--text", "-1", ...binding]);
  assert.deepEqual(
    [answer.kind, Reflect.get(answer, "text")],
    ["decision", "-1"],
  );
});

await test("CLV-008 a text option that is followed by a known flag or by no value is a usage error with the code missing-value", () => {
  for (const argumentsList of [
    ["run", "develop", "--prompt"],
    ["run", "develop", "--prompt", "--json"],
    ["run", "develop", "--prompt", "--command-id", "c-1"],
    ["run", "develop", "--prompt", "-h"],
    ["answer", "Q1", "--text", "--json", ...binding],
  ])
    assert.deepEqual(
      parseInvocation(argumentsList),
      {
        kind: "usage-error",
        code: "missing-value",
        json: argumentsList.includes("--json"),
      },
      argumentsList.join(" "),
    );
});

await test("CLV-008 a text that starts with a flag name and more characters is a value", () => {
  for (const prompt of [
    "--limit=5 is the default",
    "-v=2 of the plan",
    "--json=true",
  ]) {
    const run = parseInvocation(["run", "develop", "--prompt", prompt]);
    assert.deepEqual(
      Reflect.get(run, "source"),
      { kind: "prompt", text: prompt },
      prompt,
    );
  }
});

await test("CLV-008 a command ID or a run ID with the name of an inherited object property is a usage error", () => {
  for (const argumentsList of [
    ["run", "develop", "--prompt", "task", "--command-id", "constructor"],
    ["drop", "toString", "--expected-revision", "1"],
    ["pause", "run-1", "--expected-revision", "1", "--command-id", "valueOf"],
    [
      "answer",
      "Q1",
      "--text",
      "yes",
      ...binding,
      "--command-id",
      "hasOwnProperty",
    ],
    ["status", "constructor"],
  ])
    assert.deepEqual(
      parseInvocation(argumentsList),
      { kind: "usage-error", code: "invalid-option-value", json: false },
      argumentsList.join(" "),
    );
});

await test("CLV-008 the human form of an ambiguous reference at the CLI lists the candidates", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const second = "second approval?";
    await service.worker.openGate({
      runId: waiting.runId,
      commandId: "c-1-open-2",
      expectedRevision: 3,
      gateId: "design-2",
      kind: "approval",
      prompt: second,
      subject: digestOf(second),
    });
    await service.worker.registerWait({
      runId: waiting.runId,
      commandId: "c-1-wait-2",
      gateId: "design-2",
    });
    const ambiguous = await harness.cli([
      "approve",
      waiting.runId,
      ...binding.slice(0, 5),
      digestOf("approval of c-1?"),
    ]);
    assert.equal(ambiguous.status, 1);
    const [announcement, ...remainder] = ambiguous.stderr.split("\n");
    assert.match(announcement ?? "", /^Command ID: [0-9a-f-]{36}$/);
    assert.equal(
      remainder.join("\n"),
      `ambiguous-decision: The reference matches more than one pending decision.\nCandidates: ${waiting.runId}/design-1, ${waiting.runId}/design-2\n`,
    );
    await service.close();
  }));

await test("CLV-008 the human form of a resolver rejection at the CLI shows control characters as visible text", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          resolver: {
            id: "closed-resolver",
            version: "1",
            resolve: () =>
              Promise.resolve({
                kind: "rejected",
                code: "ticket-closed",
                detail: "The ticket is closed.\u001b[2J",
              }),
          },
        },
      ],
    });
    const closed = await harness.cli([
      "run",
      "develop",
      "--prompt",
      "task",
      "--command-id",
      "c-closed",
    ]);
    assert.equal(closed.status, 1);
    assert.equal(closed.stdout, "");
    assert.equal(
      closed.stderr,
      "ticket-closed: The ticket is closed.\\u001b[2J\nCommand ID: c-closed\n",
    );
    await service.close();
  }));
