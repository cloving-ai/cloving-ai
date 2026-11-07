import { record } from "../protocol.ts";
import type { IssueState } from "./watch-finished.ts";
import type {
  WatchCommandOutput,
  WatchCommandRunner,
} from "./watch-pr-command.ts";
import type { PrIdentity } from "./watch-pr-identity.ts";

export interface IssueObserverSettings {
  readonly command: readonly string[] | null;
  readonly directory: string;
  readonly execute: WatchCommandRunner;
  readonly now?: () => number;
}

export interface IssueObserver {
  readonly state: (issue: PrIdentity) => IssueState;
  readonly close: () => void;
}

interface Known {
  state: IssueState;
  readAt: number;
  reading: boolean;
}

const readMilliseconds = 60_000;

function issueArguments(issue: PrIdentity): readonly string[] {
  return [
    "api",
    "--method",
    "GET",
    "--hostname",
    issue.host,
    `repos/${issue.owner}/${issue.repository}/issues/${String(issue.number)}`,
  ];
}

function parsedFields(text: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(text);
    return record(value) ?? {};
  } catch {
    return {};
  }
}

export function issueStateOf(
  issue: PrIdentity,
  output: WatchCommandOutput,
): IssueState {
  if (output.status !== 0 || output.errorCode !== null) return "unknown";
  const fields = parsedFields(output.stdout);
  const expected = `https://${issue.host}/${issue.owner}/${issue.repository}/issues/${String(issue.number)}`;
  const address = fields["html_url"];
  if (
    fields["number"] !== issue.number ||
    typeof address !== "string" ||
    address.toLowerCase() !== expected.toLowerCase()
  )
    return "unknown";
  const state = fields["state"];
  return state === "open" || state === "closed" ? state : "unknown";
}

function due(known: Known | undefined, now: number): boolean {
  if (known === undefined) return true;
  if (known.reading || known.state === "closed") return false;
  return now - known.readAt >= readMilliseconds;
}

export function issueObserver(settings: IssueObserverSettings): IssueObserver {
  const now = settings.now ?? Date.now;
  const known = new Map<string, Known>();
  const stopped = new AbortController();
  let reads = Promise.resolve();
  const read = async (
    target: { readonly issue: PrIdentity; readonly command: readonly string[] },
    entry: Known,
  ): Promise<void> => {
    const { issue, command } = target;
    const output = await Promise.resolve()
      .then(() =>
        settings.execute({
          command: [...command, ...issueArguments(issue)],
          directory: settings.directory,
          signal: AbortSignal.any([stopped.signal, AbortSignal.timeout(5000)]),
        }),
      )
      .catch(() => null);
    const state = output === null ? "unknown" : issueStateOf(issue, output);
    if (state !== "unknown") entry.state = state;
    entry.readAt = now();
    entry.reading = false;
  };
  return {
    state: (issue) => {
      const key = JSON.stringify(issue);
      const entry = known.get(key);
      const command = settings.command;
      if (command === null || stopped.signal.aborted)
        return entry?.state ?? "unknown";
      if (!due(entry, now())) return entry?.state ?? "unknown";
      const next: Known = {
        state: entry?.state ?? "unknown",
        readAt: now(),
        reading: true,
      };
      known.set(key, next);
      reads = reads.then(() =>
        stopped.signal.aborted ? undefined : read({ issue, command }, next),
      );
      return next.state;
    },
    close: () => {
      stopped.abort();
    },
  };
}
