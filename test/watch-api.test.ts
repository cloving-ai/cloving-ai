import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiPaths } from "../src/cli/watch-api.ts";
import { runStates, watchApiDocument } from "../src/cli/watch-api-document.ts";
import { fields, withHarness } from "./service-fixture.ts";
import {
  contractBody,
  documentSchemas,
  openObjects,
  problemBody,
  schemaFailures,
  valueFailures,
} from "./watch-api-contract.ts";
import { foreignRequest, streamReader } from "./watch-api-fixture.ts";
import { watching } from "./watch-fixture.ts";
import { watchReplies, withWatchService } from "./watch-service-fixture.ts";

await test("CLV-254 GET api/v1/openapi.json gives the OpenAPI 3.1 document of the watch read API", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    const response = await fetch(`${watch.address}api/v1/openapi.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(
      await contractBody(watchApiDocument, {
        response,
        path: "/openapi.json",
      }),
      watchApiDocument,
    );
  });
});

await test("CLV-254 the document has openapi, info and paths, each $ref resolves, each component object is closed and the contract helper accepts each schema", () => {
  const document = watchApiDocument;
  assert.equal(document.openapi, "3.1.1");
  assert.deepEqual(document.info, {
    title: "Cloving watch API",
    version: "1.0.0",
  });
  assert.deepEqual(document.servers, [{ url: "/api/v1" }]);
  assert.deepEqual(runStates, [
    "queued",
    "running",
    "waiting_gate",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual(Object.keys(document.components.schemas), [
    "Service",
    "Workflow",
    "Schedule",
    "LoopRun",
    "CardField",
    "RunSummary",
    "RunPage",
    "RunDetail",
    "Decision",
    "Phase",
    "Review",
    "Turn",
    "Event",
    "Problem",
  ]);
  const schemas = documentSchemas(document);
  assert.equal(schemas.length, 46);
  assert.deepEqual(
    schemas.flatMap((found) => schemaFailures(document, found)),
    [],
  );
  assert.deepEqual(
    Object.entries(document.components.schemas).flatMap(([name, schema]) =>
      openObjects({ at: name, schema }),
    ),
    [],
  );
});

await test("CLV-254 the contract helper refuses another schema keyword, a $ref outside the components, a new field and a missing field", () => {
  const document = watchApiDocument;
  assert.deepEqual(
    schemaFailures(document, {
      at: "cursor",
      schema: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
    }),
    ["cursor: unsupported keyword pattern"],
  );
  assert.deepEqual(
    schemaFailures(document, {
      at: "run",
      schema: { $ref: "#/components/schemas/Missing" },
    }),
    ["run: unresolved $ref #/components/schemas/Missing"],
  );
  assert.deepEqual(
    openObjects({ at: "open", schema: { type: "object", properties: {} } }),
    ["open: object schema without additionalProperties false"],
  );
  const service = { $ref: "#/components/schemas/Service" };
  const shown = { up: true, updatedAt: "2026-11-03T10:00:00.000Z" };
  assert.deepEqual(
    valueFailures(document, { at: "body", schema: service, value: shown }),
    [],
  );
  assert.deepEqual(
    valueFailures(document, {
      at: "body",
      schema: service,
      value: { ...shown, extra: 1 },
    }),
    ["body: unexpected property extra"],
  );
  assert.deepEqual(
    valueFailures(document, {
      at: "body",
      schema: service,
      value: fields({ up: "yes" }),
    }),
    ["body: missing property updatedAt", "body.up: expected type boolean"],
  );
});

await test("CLV-254 the contract helper checks minimum, maximum and default, and refuses a range that is not a number or a default outside the schema", () => {
  const document = watchApiDocument;
  const limit = { type: "integer", minimum: 1, maximum: 200, default: 50 };
  assert.deepEqual(
    schemaFailures(document, { at: "limit", schema: limit }),
    [],
  );
  assert.deepEqual(
    [0, 1, 200, 201].map((value) =>
      valueFailures(document, { at: "limit", schema: limit, value }),
    ),
    [["limit: below the minimum 1"], [], [], ["limit: above the maximum 200"]],
  );
  assert.deepEqual(
    schemaFailures(document, {
      at: "limit",
      schema: { type: "integer", minimum: "1", maximum: null, default: "50" },
    }),
    [
      "limit: invalid minimum",
      "limit: invalid maximum",
      "limit: default outside the schema",
    ],
  );
  assert.deepEqual(
    [1.5, 0, 201].map((fallback) =>
      schemaFailures(document, {
        at: "limit",
        schema: { ...limit, default: fallback },
      }),
    ),
    [1.5, 0, 201].map(() => ["limit: default outside the schema"]),
  );
});

await test("CLV-254 GET api/v1 gives the version, the document path and one endpoint for each operation of the document", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    for (const path of ["api/v1", "api/v1/"]) {
      const response = await fetch(`${watch.address}${path}`);
      assert.equal(response.status, 200, path);
      assert.deepEqual(
        await contractBody(watchApiDocument, { response, path: "/" }),
        {
          version: 1,
          openapi: "/api/v1/openapi.json",
          endpoints: [
            ["/api/v1/", "getApiIndex"],
            ["/api/v1/openapi.json", "getOpenApiDocument"],
            ["/api/v1/service", "getService"],
            ["/api/v1/workflows", "listWorkflows"],
            ["/api/v1/schedules", "listSchedules"],
            ["/api/v1/runs", "listRuns"],
            ["/api/v1/runs/{runId}", "getRun"],
            ["/api/v1/runs/{runId}/events", "listRunEvents"],
            ["/api/v1/stream", "streamChanges"],
          ].map(([endpoint, operationId]) => ({
            method: "GET",
            path: endpoint,
            operationId,
          })),
        },
      );
    }
  });
});

await test("CLV-254 an unknown path under api/v1 gives a 404 problem with the code not-found", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    for (const path of [
      "api/v1/missing",
      "api/v1/runs/run-1/missing",
      "api/v1/runs/",
      "api/v1/stream/",
      "api/v1//",
    ]) {
      const response = await fetch(`${watch.address}${path}`);
      assert.equal(response.status, 404, path);
      assert.deepEqual(await problemBody(watchApiDocument, response), {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "The API has no resource at this path.",
        code: "not-found",
      });
    }
  });
});

await test("CLV-254 each method other than GET gives a 405 problem with the code method-not-allowed and the header Allow: GET", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    for (const [method, path] of [
      ["POST", "api/v1/runs"],
      ["DELETE", "api/v1/runs"],
      ["PUT", "api/v1"],
      ["OPTIONS", "api/v1/openapi.json"],
    ] as const) {
      const response = await fetch(`${watch.address}${path}`, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.get("allow"), "GET");
      assert.deepEqual(await problemBody(watchApiDocument, response), {
        type: "about:blank",
        title: "Method Not Allowed",
        status: 405,
        detail: "The API accepts only GET.",
        code: "method-not-allowed",
      });
    }
    assert.deepEqual(
      replies.requests.filter((request) => request.operation === "status"),
      [],
    );
  });
});

await test("CLV-254 GET api/v1/service gives up true and the time of the read when the service answers", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    const before = new Date().toISOString();
    const response = await fetch(`${watch.address}api/v1/service`);
    assert.equal(response.status, 200);
    const service = fields(
      await contractBody(watchApiDocument, { response, path: "/service" }),
    );
    assert.equal(service["up"], true);
    assert.ok(String(service["updatedAt"]) >= before);
  });
});

await test("CLV-254 with no service, GET api/v1/service gives up false and GET api/v1/workflows, GET api/v1/runs and both run paths give a 503 problem with the code service-unavailable", () =>
  withHarness(async (harness) => {
    const watch = await watching(harness.runtimeDirectory);
    try {
      const response = await fetch(`${watch.address}api/v1/service`);
      assert.equal(response.status, 200);
      const service = fields(
        await contractBody(watchApiDocument, { response, path: "/service" }),
      );
      assert.equal(service["up"], false);
      for (const [served, path] of [
        ["/workflows", "/workflows"],
        ["/runs", "/runs"],
        ["/runs/run-a", "/runs/{runId}"],
        ["/runs/run-a/events", "/runs/{runId}/events"],
      ] as const) {
        const unavailable = await fetch(`${watch.address}api/v1${served}`);
        assert.equal(unavailable.status, 503, path);
        assert.deepEqual(
          await contractBody(watchApiDocument, { response: unavailable, path }),
          {
            type: "about:blank",
            title: "Service Unavailable",
            status: 503,
            detail: "The Cloving service does not answer.",
            code: "service-unavailable",
          },
        );
      }
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));

await test("CLV-254 the server serves each path of the document, and each served path of the API is in the document", async () => {
  const replies = watchReplies({
    runs: [
      {
        runId: "run-a",
        workflowId: "develop-issue",
        state: "running",
        latestSequence: 0,
      },
    ],
  });
  await withWatchService(replies.answer, async (watch) => {
    const documented = Object.keys(watchApiDocument.paths);
    assert.deepEqual(watchApiPaths, documented);
    for (const path of documented.filter((item) => item !== "/stream")) {
      const served = path.replace("{runId}", "run-a");
      const response = await fetch(`${watch.address}api/v1${served}`);
      assert.equal(response.status, 200, path);
      await contractBody(watchApiDocument, { response, path });
    }
    const stream = streamReader(watchApiDocument, {
      response: await fetch(`${watch.address}api/v1/stream`),
      path: "/stream",
    });
    assert.match(await stream.next(), /^event: change\ndata: \{/);
    await stream.cancel();
  });
});

await test("CLV-254 the API refuses a foreign Host header with 403, sends no CORS header and sends cache-control no-store", async () => {
  const replies = watchReplies({ runs: [] });
  await withWatchService(replies.answer, async (watch) => {
    const paths = [
      "api/v1",
      ...Object.keys(watchApiDocument.paths).map((path) => `api/v1${path}`),
      "api/v1/missing",
      "api/v1/runs?limit=0",
    ];
    for (const path of paths) {
      assert.equal(await foreignRequest(watch.address, path), 403, path);
      for (const method of ["GET", "POST", "OPTIONS"]) {
        const response = await fetch(`${watch.address}${path}`, {
          method,
          headers: {
            origin: "https://foreign.example",
            "access-control-request-method": "GET",
          },
        });
        await response.body?.cancel();
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(
          [...response.headers.keys()].filter((name) =>
            name.startsWith("access-control-"),
          ),
          [],
        );
      }
    }
  });
});
