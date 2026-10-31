import { record, type Fields } from "../protocol.ts";
import type { ReportDatum } from "../report-statistics.ts";
import {
  identity,
  rows,
  timestamp,
  type Reader,
} from "./report-github-reader.ts";

async function issueNumbers(reader: Reader, since: string): Promise<number[]> {
  const result: number[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(
        `issues?state=all&since=${encodeURIComponent(since)}&per_page=100&page=${String(page)}`,
        [
          "--jq",
          'map({number, html_url, closed_at, state, state_reason} + (if has("pull_request") then {pull_request: {}} else {} end))',
        ],
      ),
    );
    for (const row of values) {
      if (Object.hasOwn(row, "pull_request")) continue;
      const number = identity(row, {
        repository: reader.repository,
        kind: "issues",
      });
      if (seen.has(number)) throw new Error("response");
      seen.add(number);
      result.push(number);
    }
    if (values.length < 100) return result;
  }
}

async function closureEvents(reader: Reader, issue: number): Promise<Fields[]> {
  const result: Fields[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(
        `issues/${String(issue)}/events?per_page=100&page=${String(page)}`,
      ),
    );
    const signature = JSON.stringify(values);
    if (seen.has(signature)) throw new Error("response");
    seen.add(signature);
    for (const event of values.filter((item) =>
      ["closed", "reopened"].includes(String(item["event"])),
    ))
      result.push(await withCloseReason(reader, event));
    if (values.length < 100) return result;
  }
}

function historyData(events: readonly Fields[], issue: number) {
  const completed: ReportDatum[] = [];
  const reopened: ReportDatum[] = [];
  let completedAt: number | null = null;
  for (const event of events.toSorted(
    (left, right) =>
      timestamp(left["created_at"]) - timestamp(right["created_at"]),
  )) {
    const at = timestamp(event["created_at"]);
    const evidence = {
      issue,
      ...(event["id"] === undefined ? {} : { eventId: event["id"] }),
    };
    if (
      event["event"] === "reopened" &&
      completedAt !== null &&
      completedAt <= at
    )
      reopened.push({ at, value: 1, evidence: { ...evidence, completedAt } });
    if (event["event"] === "reopened") continue;
    if (
      !["completed", "not_planned", "duplicate"].includes(
        String(event["state_reason"]),
      )
    )
      throw new Error("response");
    if (event["state_reason"] !== "completed") continue;
    completedAt = at;
    completed.push({ at, value: 1, evidence });
  }
  return { completed, reopened };
}

export async function readClosureHistory(reader: Reader, since: string) {
  const completed: ReportDatum[] = [];
  const reopened: ReportDatum[] = [];
  for (const issue of await issueNumbers(reader, since)) {
    const history = historyData(await closureEvents(reader, issue), issue);
    completed.push(...history.completed);
    reopened.push(...history.reopened);
  }
  return { completed, reopened };
}

async function withCloseReason(reader: Reader, event: Fields): Promise<Fields> {
  if (event["event"] !== "closed" || typeof event["state_reason"] === "string")
    return event;
  const nodeId = event["node_id"];
  if (typeof nodeId !== "string") throw new Error("response");
  return {
    ...event,
    state_reason: nodeReason(await reader.readNode(nodeId), nodeId),
  };
}

function nodeReason(value: unknown, nodeId: string): string {
  const response = record(value);
  const node = record(record(response?.["data"])?.["node"]);
  if (
    response?.["errors"] !== undefined ||
    node === undefined ||
    node["id"] !== nodeId ||
    typeof node["stateReason"] !== "string"
  )
    throw new Error("response");
  return node["stateReason"].toLowerCase();
}
