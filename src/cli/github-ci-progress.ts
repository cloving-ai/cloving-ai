import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { record, type Fields, type Reply } from "../protocol.ts";

export interface CiRerunNotice {
  readonly commit: string;
  readonly run: string;
  readonly requestedAt: number;
}

async function stored(file: string): Promise<Fields | undefined> {
  try {
    return record(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

function noticeOf(value: unknown, commit: string): CiRerunNotice[] {
  const rerun = record(value);
  const run = rerun?.["run"];
  const requestedAt = rerun?.["requestedAt"];
  if (
    typeof run !== "string" ||
    !/^\d+$/.test(run) ||
    typeof requestedAt !== "number" ||
    !Number.isFinite(requestedAt)
  )
    return [];
  return [{ commit, run, requestedAt }];
}

export async function ciRerunNotices(folder: string): Promise<CiRerunNotice[]> {
  const notices: CiRerunNotice[] = [];
  for (const file of await readdir(folder).catch(() => [])) {
    if (!/^ci-[a-f0-9]{32}\.json$/.test(file)) continue;
    const wait = await stored(join(folder, file));
    const commit = wait?.["commit"];
    if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/.test(commit))
      continue;
    const reruns: readonly unknown[] = Array.isArray(wait?.["reruns"])
      ? wait["reruns"]
      : [];
    notices.push(...reruns.flatMap((value) => noticeOf(value, commit)));
  }
  return notices.toSorted(
    (first, second) => first.requestedAt - second.requestedAt,
  );
}

export async function withCiReruns(
  runtimeDirectory: string,
  reply: Reply,
): Promise<Reply> {
  if (reply.kind !== "result") return reply;
  const journal = join(dirname(runtimeDirectory), "github");
  const notices = new Map<string, CiRerunNotice[]>();
  for (const key of await readdir(journal).catch(() => [])) {
    const folder = join(journal, key);
    const started = await stored(join(folder, "started.json"));
    const runId = started?.["runId"];
    if (started?.["method"] !== "merge" || typeof runId !== "string") continue;
    notices.set(runId, [
      ...(notices.get(runId) ?? []),
      ...(await ciRerunNotices(folder)),
    ]);
  }
  const shown = (value: unknown): unknown => {
    const run = record(value);
    const found = notices.get(String(run?.["runId"])) ?? [];
    return found.length === 0 ? value : { ...run, ciReruns: found };
  };
  const { result } = reply;
  return {
    kind: "result",
    result: {
      ...result,
      ...(result["run"] === undefined ? {} : { run: shown(result["run"]) }),
      ...(Array.isArray(result["runs"])
        ? { runs: result["runs"].map(shown) }
        : {}),
    },
  };
}
