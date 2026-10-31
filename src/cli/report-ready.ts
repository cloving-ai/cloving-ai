import { record, type Fields } from "../protocol.ts";
import type { ReportReadyTicket } from "../report-flow-types.ts";
import { hardDependencies } from "../ticket-dependencies.ts";
import {
  rows,
  identity,
  timestamp,
  issueTimeline,
  type Reader,
} from "./report-github-reader.ts";

function intervals(events: readonly Fields[]): ReportReadyTicket["intervals"] {
  const labels = events
    .filter(
      (event) =>
        ["labeled", "unlabeled"].includes(String(event["event"])) &&
        record(event["label"])?.["name"] === "cloving: ready",
    )
    .map((event) => ({
      type: event["event"],
      at: timestamp(event["created_at"]),
    }))
    .toSorted((a, b) => a.at - b.at);
  const result: { start: number; end: number | null }[] = [];
  let start: number | null = null;
  for (const label of labels) {
    if (label.type === "labeled") start ??= label.at;
    else if (start !== null) {
      result.push({ start, end: label.at });
      start = null;
    }
  }
  if (start !== null) result.push({ start, end: null });
  return result;
}

async function detail(
  reader: Pick<Reader, "repository" | "read">,
  number: number,
): Promise<Fields> {
  const row = record(await reader.read(`issues/${String(number)}`));
  if (
    row === undefined ||
    identity(row, { repository: reader.repository, kind: "issues" }) !==
      number ||
    Object.hasOwn(row, "pull_request")
  )
    throw new Error("identity");
  return row;
}

async function dependencies(
  reader: Pick<Reader, "repository" | "read">,
  row: Fields,
) {
  const body = row["body"];
  if (body !== null && typeof body !== "string") throw new Error("response");
  const result = [];
  for (const id of hardDependencies(body ?? "")) {
    const number = Number(id);
    if (!Number.isSafeInteger(number)) throw new Error("identity");
    const dependency = await detail(reader, number);
    const state = dependency["state"];
    if (state !== "closed" && state !== "open") throw new Error("response");
    result.push({
      issue: number,
      closedAt: state === "open" ? null : timestamp(dependency["closed_at"]),
    });
  }
  return result;
}

export async function readyTicketsOf(
  reader: Pick<Reader, "repository" | "read">,
): Promise<ReportReadyTicket[]> {
  const result: ReportReadyTicket[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(`issues?state=all&per_page=100&page=${String(page)}`, [
        "--jq",
        'map({number, html_url} + (if has("pull_request") then {pull_request: {}} else {} end))',
      ]),
    );
    const numbers: number[] = [];
    for (const row of values) {
      if (Object.hasOwn(row, "pull_request")) continue;
      const number = identity(row, {
        repository: reader.repository,
        kind: "issues",
      });
      if (seen.has(number)) throw new Error("response");
      seen.add(number);
      numbers.push(number);
    }
    for (let offset = 0; offset < numbers.length; offset += 5) {
      const tickets = await Promise.all(
        numbers
          .slice(offset, offset + 5)
          .map((number) => readyTicket(reader, number)),
      );
      result.push(...tickets.filter((ticket) => ticket !== null));
    }
    if (values.length < 100) return result;
  }
}

async function readyTicket(
  reader: Pick<Reader, "repository" | "read">,
  number: number,
) {
  const ready = intervals(await issueTimeline(reader, number));
  if (ready.length === 0) return null;
  return {
    issue: number,
    intervals: ready,
    dependencies: await dependencies(reader, await detail(reader, number)),
  };
}
