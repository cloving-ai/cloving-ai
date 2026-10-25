import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServiceRequest } from "../src/protocol.ts";
import {
  actionHeaders,
  cardRequest,
  declaredWatch,
  pageToken,
  postCard,
} from "./watch-action-fixture.ts";
import { withWatchService } from "./watch-service-fixture.ts";

await test("CLV-135 a run request without a page token is refused before contacting the service", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    (request) => {
      if (request.operation === "run") requests.push(request);
      return { kind: "result", result: {} };
    },
    async (watch) => {
      const reply = await fetch(`${watch.address}actions/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(watch.address).origin,
        },
        body: JSON.stringify({
          workflowId: "develop-prd",
          fields: { prompt: "Idea" },
          commandId: "card-1",
        }),
      });
      assert.equal(reply.status, 403);
      assert.equal(await reply.text(), "refused");
      assert.deepEqual(requests, []);
    },
  );
});

await test("CLV-135 a valid page request forwards CLI run parameters and returns the service reply", () => {
  const requests: ServiceRequest[] = [];
  const admitted = {
    kind: "result",
    result: { code: "run-admitted", runId: "run-card" },
  } as const;
  return withWatchService(
    (request) => {
      if (request.operation === "run") requests.push(request);
      return request.operation === "run"
        ? admitted
        : {
            kind: "result",
            result: { runs: [], workflows: ["develop-prd"] },
          };
    },
    async (watch) => {
      const token = await pageToken(watch);
      const reply = await postCard(watch, {
        headers: actionHeaders(watch, token),
      });
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), admitted);
      assert.deepEqual(requests, [
        {
          operation: "run",
          parameters: {
            workflowId: "develop-prd",
            source: "prompt",
            submission: cardRequest.fields,
            commandId: "card-1",
          },
        },
      ]);
    },
  );
});

for (const [name, patch] of [
  ["wrong token", { "x-cloving-token": "wrong" }],
  ["foreign origin", { origin: "https://foreign.example" }],
  ["foreign host", { host: "rebound.example" }],
  ["wrong port", { host: "localhost:1" }],
  ["form content", { "content-type": "application/x-www-form-urlencoded" }],
  ["text content", { "content-type": "text/plain" }],
] as const) {
  await test(`CLV-135 refuses ${name} without a run request`, () => {
    const requests: ServiceRequest[] = [];
    return withWatchService(
      (request) => {
        if (request.operation === "run") requests.push(request);
        return {
          kind: "result",
          result: { runs: [], workflows: ["develop-prd"] },
        };
      },
      async (watch) => {
        const token = await pageToken(watch);
        const reply = await postCard(watch, {
          headers: { ...actionHeaders(watch, token), ...patch },
        });
        assert.equal(reply.status, 403);
        assert.equal(reply.body, "refused");
        assert.deepEqual(requests, []);
      },
    );
  });
}

for (const [name, body] of [
  [
    "oversized body",
    JSON.stringify({ ...cardRequest, fields: { prompt: "x".repeat(16384) } }),
  ],
  [
    "unknown workflow",
    JSON.stringify({ ...cardRequest, workflowId: "unknown" }),
  ],
  [
    "extra field",
    JSON.stringify({
      ...cardRequest,
      fields: { prompt: "Idea", authority: "yes" },
    }),
  ],
  [
    "extra envelope field",
    JSON.stringify({ ...cardRequest, source: "prompt" }),
  ],
  ["invalid JSON", "{"],
  ["invalid field", JSON.stringify({ ...cardRequest, fields: { prompt: 42 } })],
  ["missing field", JSON.stringify({ ...cardRequest, fields: {} })],
  ["empty command", JSON.stringify({ ...cardRequest, commandId: "" })],
] as const) {
  await test(`CLV-135 refuses ${name} without a run request`, () => {
    const requests: ServiceRequest[] = [];
    return withWatchService(
      (request) => {
        if (request.operation === "run") requests.push(request);
        return {
          kind: "result",
          result: { runs: [], workflows: ["develop-prd"] },
        };
      },
      async (watch) => {
        const reply = await postCard(watch, {
          headers: actionHeaders(watch, await pageToken(watch)),
          body,
        });
        assert.equal(reply.status, 403);
        assert.equal(reply.body, "refused");
        assert.deepEqual(requests, []);
      },
    );
  });
}

await test("CLV-135 off removes the token and makes the endpoint an unknown path", () =>
  withWatchService(
    {
      answer: () => ({
        kind: "result",
        result: { runs: [], workflows: ["develop-prd"] },
      }),
      configure: () =>
        Promise.resolve({ environment: { CLOVING_WATCH_ACTIONS: "off" } }),
    },
    async (watch) => {
      const page = await (await fetch(watch.address)).text();
      assert.match(page, /const actionToken = null;/);
      const model: unknown = await (
        await fetch(`${watch.address}data.json`)
      ).json();
      assert.deepEqual(Reflect.get(Object(model), "cardForms"), []);
      const reply = await postCard(watch, {
        headers: actionHeaders(watch, "wrong"),
      });
      assert.equal(reply.status, 404);
      assert.equal(reply.body, "not found");
    },
  ));

await test("CLV-135 declared string inputs are exposed and forwarded with source input", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    {
      answer: (request) => {
        if (request.operation === "run") requests.push(request);
        return {
          kind: "result",
          result: { runs: [], workflows: ["review-corpus", "unknown"] },
        };
      },
      configure: declaredWatch,
    },
    async (watch) => {
      const model: unknown = await (
        await fetch(`${watch.address}data.json`)
      ).json();
      assert.deepEqual(Reflect.get(Object(model), "cardForms"), [
        {
          workflowId: "review-corpus",
          source: "input",
          fields: [
            {
              name: "importId",
              label: "importId",
              multiline: false,
              optional: false,
            },
          ],
        },
      ]);
      const reply = await postCard(watch, {
        headers: actionHeaders(watch, await pageToken(watch)),
        body: JSON.stringify({
          ...cardRequest,
          workflowId: "review-corpus",
          fields: { importId: "import-1" },
        }),
      });
      assert.equal(reply.status, 200);
      assert.deepEqual(requests, [
        {
          operation: "run",
          parameters: {
            workflowId: "review-corpus",
            source: "input",
            submission: { importId: "import-1" },
            commandId: "card-1",
          },
        },
      ]);
    },
  );
});

await test("CLV-135 valid input reports an unavailable service without disguising it as a security refusal", () =>
  withWatchService(
    () => ({
      kind: "error",
      error: { code: "service-unavailable", detail: "Start the service." },
    }),
    async (watch) => {
      const reply = await postCard(watch, {
        headers: actionHeaders(watch, await pageToken(watch)),
      });
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), {
        kind: "error",
        error: { code: "service-unavailable", detail: "Start the service." },
      });
    },
  ));

await test("CLV-135 missing content type and an unregistered built-in workflow are refused", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    (request) => {
      if (request.operation === "run") requests.push(request);
      return { kind: "result", result: { runs: [], workflows: [] } };
    },
    async (watch) => {
      const headers = actionHeaders(watch, await pageToken(watch));
      const absent = { ...headers };
      delete absent["content-type"];
      for (const sent of [absent, headers]) {
        const reply = await postCard(watch, { headers: sent });
        assert.equal(reply.status, 403);
        assert.equal(reply.body, "refused");
      }
      assert.deepEqual(requests, []);
      const preflight = await fetch(`${watch.address}actions/run`, {
        method: "OPTIONS",
        headers: {
          origin: "https://foreign.example",
          "access-control-request-method": "POST",
        },
      });
      assert.equal(preflight.status, 404);
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);
      const rebound = await postCard(watch, {
        headers: {
          ...headers,
          host: "evil.example:" + new URL(watch.address).port,
        },
      });
      assert.equal(rebound.status, 403);
    },
  );
});
