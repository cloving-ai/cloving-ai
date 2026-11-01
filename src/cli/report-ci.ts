import { record, type Fields } from "../protocol.ts";
import type { ReportDatum } from "../report-statistics.ts";
import { rows, timestamp, type Reader } from "./report-github-reader.ts";

export function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("response");
  return value;
}

export async function mainRuns(
  reader: Reader,
  input: { readonly since: string; readonly activity: "created" | "updated" },
) {
  const filter =
    input.activity === "created"
      ? `branch=main&created=%3E%3D${encodeURIComponent(input.since)}&`
      : "";
  const runs = await runPages(reader, {
    filter,
    maximum: input.activity === "created" ? 1000 : Infinity,
  });
  return runs.filter((run) => {
    if (run["name"] !== "CI" || run["head_branch"] !== "main") return false;
    if (timestamp(run[`${input.activity}_at`]) < Date.parse(input.since))
      return false;
    timestamp(run["created_at"]);
    positiveInteger(run["run_attempt"]);
    return true;
  });
}

async function runPages(
  reader: Reader,
  input: { readonly filter: string; readonly maximum: number },
) {
  const result: Fields[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const response = record(
      await reader.read(
        `actions/runs?${input.filter}per_page=100&page=${String(page)}`,
      ),
    );
    if (Number(response?.["total_count"]) > input.maximum)
      throw new Error("response-truncated");
    const values = rows(response?.["workflow_runs"]);
    for (const run of values) {
      const id = positiveInteger(run["id"]);
      if (seen.has(id)) throw new Error("response");
      seen.add(id);
      result.push(run);
    }
    if (values.length < 100) return result;
  }
}

export async function firstPassData(
  reader: Reader,
  runs: readonly Fields[],
): Promise<ReportDatum[]> {
  const result: ReportDatum[] = [];
  for (const run of runs) {
    const first =
      run["run_attempt"] === 1
        ? run
        : record(
            await reader.read(`actions/runs/${String(run["id"])}/attempts/1`),
          );
    if (
      first === undefined ||
      first["id"] !== run["id"] ||
      first["run_attempt"] !== 1 ||
      first["head_sha"] !== run["head_sha"]
    )
      throw new Error("response");
    const conclusion = first["conclusion"];
    if (conclusion !== null && typeof conclusion !== "string")
      throw new Error("response");
    result.push({
      at: timestamp(run["created_at"]),
      value: conclusion === "success" ? 1 : 0,
      evidence: {
        runId: run["id"],
        commit: run["head_sha"],
        attempt: 1,
        conclusion,
      },
    });
  }
  return result;
}
