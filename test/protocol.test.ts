import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eventLine,
  parseReplyLine,
  parseRequest,
  replyLine,
  requestLine,
} from "../src/protocol.ts";
import { checkSubmission } from "../src/submission.ts";

await test("CLV-008 a request line and a reply line survive one encode and decode", () => {
  const request = { operation: "status", parameters: { runId: "run-1" } };
  assert.deepEqual(parseRequest(requestLine(request).trim()), {
    kind: "request",
    request,
  });
  const result = { kind: "result", result: { kind: "run-list" } } as const;
  assert.deepEqual(parseReplyLine(replyLine(result).trim()), result);
  const error = {
    kind: "error",
    error: { code: "unknown-run", detail: "No run.", runId: "run-9" },
  } as const;
  assert.deepEqual(parseReplyLine(replyLine(error).trim()), error);
  assert.deepEqual(parseReplyLine(eventLine({ sequence: 1 }).trim()), {
    kind: "event",
    event: { sequence: 1 },
  });
});

await test("CLV-008 a line that is not a request or not a reply is refused", () => {
  for (const line of [
    "",
    "[]",
    "5",
    '{"protocol":1}',
    '{"protocol":1,"operation":5,"parameters":{}}',
  ])
    assert.equal(parseRequest(line).kind, "error", line);
  for (const line of [
    "",
    "[]",
    '{"ok":true}',
    '{"ok":false,"error":{"code":"x"}}',
    '{"ok":false,"error":{"detail":"x"}}',
    '{"ok":true,"result":[]}',
  ])
    assert.equal(parseReplyLine(line), undefined, line);
});

await test("CLV-008 a submission check gives the normalized request for a valid submission", () => {
  const contract = { maximumBytes: 64, fields: { prompt: "string" } } as const;
  assert.deepEqual(
    checkSubmission(contract, {
      workflowId: "develop",
      submission: { prompt: "task" },
      source: "input",
    }),
    {
      kind: "valid",
      normalized: '{"submission":{"prompt":"task"},"workflowId":"develop"}',
      submission: { prompt: "task" },
    },
  );
  assert.equal(
    checkSubmission(contract, {
      workflowId: "develop",
      submission: {},
      source: "prompt",
    }).kind,
    "rejected",
  );
});
