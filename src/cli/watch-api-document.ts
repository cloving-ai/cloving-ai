import type { RunStatus } from "../authority/transitions.ts";

export const runStates = [
  "queued",
  "running",
  "waiting_gate",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
const integer = { type: "integer" };
const flag = { type: "boolean" };

function reference(name: string): { readonly $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function closed(properties: Readonly<Record<string, unknown>>) {
  return {
    type: "object",
    required: Object.keys(properties),
    properties,
    additionalProperties: false,
  };
}

function listOf(items: unknown) {
  return { type: "array", items };
}

function json(description: string, schema: unknown) {
  return { description, content: { "application/json": { schema } } };
}

function problem(description: string) {
  return {
    description,
    content: { "application/problem+json": { schema: reference("Problem") } },
  };
}

const invalidQuery = problem(
  "A query parameter is unknown, repeated or has an invalid value.",
);
const serviceUnavailable = problem("The Cloving service does not answer.");

const documentSchema = closed({
  openapi: { const: "3.1.1" },
  info: closed({ title: text, version: text }),
  servers: listOf(closed({ url: text })),
  tags: listOf(closed({ name: text, description: text })),
  paths: { type: "object" },
  components: { type: "object" },
});

const indexSchema = closed({
  version: { const: 1 },
  openapi: text,
  endpoints: listOf(
    closed({ method: { const: "GET" }, path: text, operationId: text }),
  ),
});

const runParameters = [
  {
    name: "workflowId",
    in: "query",
    description: "Give only the runs of this workflow.",
    schema: text,
  },
  {
    name: "state",
    in: "query",
    description: "Give only the runs in this state.",
    schema: { type: "string", enum: runStates },
  },
  {
    name: "limit",
    in: "query",
    description:
      "The maximum number of runs on the page, from 1 to 200. The default is 50.",
    schema: integer,
  },
  {
    name: "cursor",
    in: "query",
    description: "The nextCursor value of the previous page.",
    schema: text,
  },
];

export const watchApiDocument = {
  openapi: "3.1.1",
  info: { title: "Cloving watch API", version: "1.0.0" },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "api", description: "The index and the contract of the API." },
    { name: "service", description: "The state of the Cloving service." },
    { name: "workflows", description: "The workflows of the service." },
    { name: "runs", description: "The runs of the watch page." },
  ],
  paths: {
    "/": {
      get: {
        operationId: "getApiIndex",
        tags: ["api"],
        summary: "Give the version and the endpoints of the API.",
        responses: {
          "200": json("The index of the API.", indexSchema),
          "400": invalidQuery,
        },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        tags: ["api"],
        summary: "Give this OpenAPI document.",
        responses: {
          "200": json("The OpenAPI document of the API.", documentSchema),
          "400": invalidQuery,
        },
      },
    },
    "/service": {
      get: {
        operationId: "getService",
        tags: ["service"],
        summary: "Tell if the Cloving service answers.",
        responses: {
          "200": json("The state of the service.", reference("Service")),
          "400": invalidQuery,
        },
      },
    },
    "/workflows": {
      get: {
        operationId: "listWorkflows",
        tags: ["workflows"],
        summary: "Give the workflows of the service and their card fields.",
        responses: {
          "200": json(
            "The workflows of the service.",
            closed({ workflows: listOf(reference("Workflow")) }),
          ),
          "400": invalidQuery,
          "503": serviceUnavailable,
        },
      },
    },
    "/runs": {
      get: {
        operationId: "listRuns",
        tags: ["runs"],
        summary:
          "Give the active runs and the runs with an event in the last 7 days, newest first.",
        parameters: runParameters,
        responses: {
          "200": json("One page of runs.", reference("RunPage")),
          "400": invalidQuery,
          "503": serviceUnavailable,
        },
      },
    },
  },
  components: {
    schemas: {
      Service: closed({ up: flag, updatedAt: text }),
      Workflow: closed({
        workflowId: text,
        activeCount: integer,
        waitingCount: integer,
        latestAt: nullableText,
        inputs: listOf(reference("CardField")),
      }),
      CardField: closed({
        name: text,
        label: text,
        multiline: flag,
        optional: flag,
      }),
      RunSummary: closed({
        runId: text,
        workflowId: text,
        ticketId: nullableText,
        title: nullableText,
        state: { type: "string", enum: runStates },
        outcome: nullableText,
        currentStep: closed({ name: text, startedAt: nullableText }),
        latestAt: nullableText,
        pullRequest: {
          oneOf: [closed({ number: integer, url: text }), { type: "null" }],
        },
        estimatedCostUsd: { type: ["number", "null"] },
      }),
      RunPage: closed({
        runs: listOf(reference("RunSummary")),
        nextCursor: nullableText,
      }),
      Problem: closed({
        type: text,
        title: text,
        status: integer,
        detail: text,
        code: text,
      }),
    },
  },
};
