import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { callTool, sameAsCli } from "./mcp-fixture.ts";
import {
  fields,
  items,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

async function decisions(
  harness: Harness,
  runId: string,
): Promise<readonly Fields[]> {
  const listed = await callTool({
    runtime: harness.runtimeDirectory,
    name: "cloving_questions",
    arguments: { runId },
  });
  return items(fields(listed["structuredContent"])["decisions"]).map(fields);
}

async function binding(harness: Harness, runId: string): Promise<Fields> {
  const [decision] = await decisions(harness, runId);
  return {
    reference: decision?.["decisionId"],
    expectedRevision: decision?.["revision"],
    generation: decision?.["generation"],
    subjectDigest: decision?.["subjectDigest"],
  };
}

function options(values: Fields): readonly string[] {
  return [
    String(values["reference"]),
    "--expected-revision",
    String(values["expectedRevision"]),
    "--generation",
    String(values["generation"]),
    "--subject-digest",
    String(values["subjectDigest"]),
    ...(typeof values["text"] === "string" ? ["--text", values["text"]] : []),
    "--command-id",
    String(values["commandId"]),
  ];
}

const recorded = [
  ["cloving_answer", "question", "answer", "Use the parser."],
  ["cloving_approve", "approval", "approve", undefined],
  ["cloving_deny", "approval", "deny", "Split the change."],
  ["cloving_deny", "approval", "deny", undefined],
] as const;

await test("CLV-251 cloving_answer, cloving_approve and cloving_deny record the decision and give the JSON of the CLI", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    for (const [index, [name, kind, command, text]] of recorded.entries()) {
      const { runId } = await waitingGate(harness, {
        service,
        commandId: `gate-${String(index)}`,
        kind,
      });
      const values = {
        ...(await binding(harness, runId)),
        ...(text === undefined ? {} : { text }),
        commandId: `c-${String(index)}`,
      };
      const { first, cli } = await sameAsCli(harness, {
        name,
        arguments: values,
        cli: [command, ...options(values)],
      });
      assert.notEqual(first["isError"], true, JSON.stringify(first));
      const content = fields(first["structuredContent"]);
      assert.equal(content["replayed"], false);
      assert.equal(cli["replayed"], true);
      assert.deepEqual(content["receipt"], cli["receipt"]);
      assert.deepEqual(await decisions(harness, runId), []);
    }
  }));

await test("CLV-251 a decision tool with a stale expectedRevision or a feedback text above 8000 bytes gives the refusal of the service as the CLI does and records nothing", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "gate",
      kind: "approval",
    });
    const values = await binding(harness, runId);
    const stale = {
      ...values,
      expectedRevision: Number(values["expectedRevision"]) + 1,
      commandId: "c-stale",
    };
    const long = { ...values, text: "é".repeat(4001), commandId: "c-long" };
    for (const [name, command, given, code] of [
      ["cloving_approve", "approve", stale, "stale-revision"],
      ["cloving_deny", "deny", long, "input-too-large"],
    ] as const) {
      const { first } = await sameAsCli(harness, {
        name,
        arguments: given,
        cli: [command, ...options(given)],
      });
      assert.equal(first["isError"], true);
      assert.equal(fields(first["structuredContent"])["code"], code);
      assert.equal((await decisions(harness, runId)).length, 1);
    }
  }));
