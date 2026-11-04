import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { fields } from "./service-fixture.ts";
import { contractBody } from "./watch-api-contract.ts";
import {
  mergeJournal,
  mergePull,
  writeMergeRecords,
} from "./watch-merge-fixture.ts";
import type { WatchOptions } from "./watch-fixture.ts";
import { watchReplies } from "./watch-service-fixture.ts";

const now = Date.now();

export function minutesAgo(minutes: number): string {
  return new Date(now - minutes * 60000).toISOString();
}

export const pendingDecision = {
  runId: "run-new",
  decisionId: "run-new/design-1",
  type: "approval",
  prompt: "Approve the design of the API?",
  revision: 3,
  generation: 2,
  subjectDigest: "digest-1",
};

function eventsOf(runId: string, start: number): readonly Fields[] {
  return ["run.created", "step.started", "step.completed", "run.paused"].map(
    (type, index) => ({
      sequence: index + 1,
      recordedAt: minutesAgo(start - index),
      type,
      payload: { runId },
    }),
  );
}

export const newEvents = eventsOf("run-new", 10);

export function detailReplies(): ReturnType<typeof watchReplies> {
  const replies = watchReplies({
    workflows: ["develop"],
    runs: [
      {
        runId: "run-new",
        workflowId: "develop",
        state: "waiting_gate",
        latestSequence: 4,
        latestAt: minutesAgo(1),
        ticketId: "CLV-255",
        title: "Add the run detail",
        estimatedCostUsd: 2.5,
        reason: { code: "decision-open", detail: "The design waits." },
        budget: { spent: 3, limit: 10 },
      },
      {
        runId: "run-old",
        workflowId: "develop",
        state: "completed",
        latestSequence: 4,
        latestAt: minutesAgo(60 * 24 * 30),
        outcome: { kind: "handoff_requested" },
      },
    ],
    eventsByRun: {
      "run-new": newEvents,
      "run-old": eventsOf("run-old", 60 * 24 * 30 + 10),
    },
  });
  const answer = (request: ServiceRequest): Reply => {
    const reply = replies.answer(request);
    if (request.operation !== "questions") return reply;
    return { kind: "result", result: { decisions: [pendingDecision] } };
  };
  return { requests: replies.requests, answer };
}

async function writeTurn(runtime: string): Promise<void> {
  const folder = join(dirname(runtime), "journal", "turn-1");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "started.json"),
    JSON.stringify({
      operationId: JSON.stringify([
        "cloving-operation",
        1,
        "run-new",
        "implement",
        "claude-turn",
      ]),
      harness: "claude",
      target: "clv-255",
      startedAt: minutesAgo(9),
    }),
  );
  await writeFile(
    join(folder, "result.json"),
    JSON.stringify({
      outcome: "completed",
      result: JSON.stringify({
        summary: "Added the run detail.",
        estimatedCostUsd: 0.75,
      }),
      endedAt: minutesAgo(8),
    }),
  );
}

export async function detailRecords(runtime: string): Promise<WatchOptions> {
  await writeTurn(runtime);
  await writeMergeRecords(runtime, [
    mergeJournal("run-old", { method: "open-pr", report: mergePull }),
    mergeJournal("run-old", {
      method: "wait-review",
      report: { commit: "commit-1", score: 4 },
    }),
    mergeJournal("run-old", {
      method: "merge",
      report: { number: 7, merged: "merge-commit-1" },
    }),
  ]);
  return {};
}

export async function runDetail(
  address: string,
  runId: string,
): Promise<Fields> {
  const response = await fetch(
    `${address}api/v1/runs/${encodeURIComponent(runId)}`,
  );
  assert.equal(response.status, 200, runId);
  const body = fields(
    await contractBody(watchApiDocument, {
      response,
      path: "/runs/{runId}",
    }),
  );
  assert.deepEqual(Object.keys(body), ["run"]);
  return fields(body["run"]);
}

export function foreignRequest(
  address: string,
  path: string,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const sent = request(
      new URL(path, address),
      { headers: { host: `rebound.example:${new URL(address).port}` } },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode);
        });
      },
    );
    sent.on("error", reject);
    sent.end();
  });
}

export interface StreamReader {
  readonly next: () => Promise<string>;
  readonly cancel: () => Promise<void>;
}

export function streamReader(
  document: typeof watchApiDocument,
  exchange: { readonly response: Response; readonly path: string },
): StreamReader {
  const { response, path } = exchange;
  assert.equal(response.status, 200, path);
  const media = response.headers.get("content-type") ?? "";
  const operation = fields(fields(document.paths)[path])["get"];
  const content = fields(
    fields(fields(fields(operation)["responses"])["200"])["content"],
  );
  assert.ok(
    Object.hasOwn(content, media),
    `GET ${path} documents no 200 ${media} response`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.body);
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const decoder = new TextDecoder();
  const buffer = { text: "" };
  const next = async (): Promise<string> => {
    while (!buffer.text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) return buffer.text;
      buffer.text += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.text.indexOf("\n\n") + 2;
    const message = buffer.text.slice(0, end);
    buffer.text = buffer.text.slice(end);
    return message;
  };
  return { next, cancel: () => reader.cancel() };
}
