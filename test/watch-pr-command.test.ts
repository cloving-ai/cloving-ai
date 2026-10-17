import assert from "node:assert/strict";
import { test } from "node:test";
import { prOutput } from "./watch-pr-fixture.ts";
import { prArguments, prCommandResult } from "../src/cli/watch-pr-command.ts";

const identity = {
  host: "github.example",
  owner: "fixture",
  repository: "demo",
  number: 7,
};
const success = prOutput(true);

await test("CLV-093 the command is exactly one explicit host and repository PR GET", () => {
  assert.deepEqual(prArguments(identity), [
    "api",
    "--method",
    "GET",
    "--hostname",
    "github.example",
    "repos/fixture/demo/pulls/7",
    "--include",
  ]);
  assert.deepEqual(prCommandResult(identity, success), { status: "merged" });
});

await test("CLV-093 command failures expose only fixed categories", () => {
  for (const [failure, changes] of [
    ["command", { status: null, errorCode: "ENOENT" }],
    ["command", { status: 1, stderr: "secret upstream failure" }],
    ["access", { status: 4, stderr: "private authentication detail" }],
    [
      "access",
      { status: 1, stderr: "gh: permission denied (HTTP 403) token-secret" },
    ],
    ["access", { status: 1, stderr: "gh: missing (HTTP 404) token-secret" }],
    ["access", { status: 1, stderr: "gh: auth (HTTP 401) token-secret" }],
    [
      "rate-limit",
      {
        status: 1,
        stderr: "gh: API rate limit exceeded (HTTP 403) token-secret",
      },
    ],
    ["rate-limit", { status: 1, stdout: "HTTP/2.0 429\r\n\r\n{}" }],
    [
      "rate-limit",
      {
        status: 1,
        stdout: "HTTP/2.0 403\r\nx-ratelimit-remaining: 0\r\n\r\n{}",
      },
    ],
    ["response", { stdout: "private invalid output" }],
    [
      "response",
      {
        stdout:
          "HTTP/2.0 200\r\nContent-Type: application/json\r\n\r\nprivate invalid JSON",
      },
    ],
    ["response", { stdout: "HTTP/2.0 200\n\nnull" }],
    ["response", { stdout: "HTTP/2.0 200\n\n{}" }],
  ] as const)
    assert.deepEqual(prCommandResult(identity, { ...success, ...changes }), {
      status: "unavailable",
      failure,
    });
});
