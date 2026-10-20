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
  assert.deepEqual(prCommandResult(identity, { output: success, now: 1000 }), {
    status: "merged",
  });
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
    assert.deepEqual(
      prCommandResult(identity, {
        output: { ...success, ...changes },
        now: 1000,
      }),
      {
        status: "unavailable",
        failure,
        ...(failure === "rate-limit" ? { retryAt: 61000 } : {}),
      },
    );
});

await test("CLV-129 rate-limit headers select the latest valid supplied deadline", () => {
  const now = 1700000000000;
  for (const [headers, delay] of [
    ["Retry-After: 5", 5000],
    ["retry-after: 0", 0],
    [
      "Retry-After: 120\r\nx-ratelimit-remaining: 0\r\nX-RateLimit-Reset: 1700000180",
      180000,
    ],
    [
      "Retry-After: 240\r\nx-ratelimit-remaining: 0\r\nX-RateLimit-Reset: 1700000180",
      240000,
    ],
    [
      "Retry-After: invalid\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1700000090",
      90000,
    ],
    ["X-RateLimit-Remaining: 1\r\nX-RateLimit-Reset: 1700000180", 60000],
    ["X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1699999999", 0],
    ["Retry-After: 5\r\nretry-after: 10", 10000],
  ] as const) {
    const output = {
      ...success,
      status: 1,
      stdout: `HTTP/2.0 429\r\n${headers}\r\n\r\n{}`,
    };
    assert.deepEqual(
      prCommandResult(identity, { output, now }),
      {
        status: "unavailable",
        failure: "rate-limit",
        retryAt: now + delay,
      },
      headers,
    );
  }
});

await test("CLV-129 invalid or absent rate-limit deadlines fall back to 60 seconds", () => {
  const now = 1700000000000;
  for (const value of [
    "",
    "-1",
    "1.5",
    "1e3",
    "Infinity",
    "NaN",
    "9007199254740992",
    "9007199254741",
    "Wed, 21 Oct 2026 07:28:00 GMT",
  ]) {
    const output = {
      ...success,
      status: 1,
      stdout: `HTTP/2.0 403\r\nRetry-After: ${value}\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${value}\r\n\r\n{}`,
    };
    assert.deepEqual(
      prCommandResult(identity, { output, now }),
      {
        status: "unavailable",
        failure: "rate-limit",
        retryAt: now + 60000,
      },
      value,
    );
  }
  const body = {
    ...success,
    status: 1,
    stdout:
      "HTTP/2.0 429\n\nRetry-After: 1000\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 1800000000",
  };
  assert.deepEqual(prCommandResult(identity, { output: body, now }), {
    status: "unavailable",
    failure: "rate-limit",
    retryAt: now + 60000,
  });
});
