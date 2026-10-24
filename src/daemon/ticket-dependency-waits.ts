import { hardDependencies } from "../ticket-dependencies.ts";
import { issueIdentity } from "../issue-identity.ts";
import { record, type Fields } from "../protocol.ts";
import { calls } from "./github-calls.ts";
import { ticketText } from "./ticket-source.ts";

interface Source {
  readonly repository: string;
  readonly command: readonly string[] | undefined;
  readonly githubCommand?: readonly string[] | undefined;
}

async function openDependencies(
  source: Source,
  candidate: { readonly ticket: string; readonly signal: AbortSignal },
): Promise<readonly string[]> {
  const github = calls(
    { repository: source.repository, gh: source.githubCommand ?? ["gh"] },
    candidate.signal,
  );
  const issue = issueIdentity(candidate.ticket);
  const repository =
    issue === null ? "{owner}/{repo}" : `${issue.owner}/${issue.repository}`;
  const open: string[] = [];
  for (const id of hardDependencies(candidate.ticket)) {
    const response: unknown = JSON.parse(
      await github.gh(["api", `repos/${repository}/issues/${id}`]),
    );
    const state = record(response)?.["state"];
    if (state !== "open" && state !== "closed")
      throw new Error("invalid-dependency-state");
    if (state === "open") open.push(id);
  }
  return open;
}

export function ticketDependencyWaits(source: Source): {
  readonly check: (candidate: {
    readonly ticketId: string;
    readonly ticket: string;
    readonly signal: AbortSignal;
  }) => Promise<readonly string[]>;
  readonly refresh: (signal: AbortSignal) => Promise<readonly string[]>;
  readonly skipped: () => readonly Fields[];
} {
  const waiting = new Map<string, readonly string[]>();
  const check = async (candidate: {
    readonly ticketId: string;
    readonly ticket: string;
    readonly signal: AbortSignal;
  }): Promise<readonly string[]> => {
    const open = await openDependencies(source, candidate);
    if (open.length === 0) waiting.delete(candidate.ticketId);
    else waiting.set(candidate.ticketId, open);
    return open;
  };
  return {
    check,
    refresh: async (signal) => {
      for (const ticketId of waiting.keys()) {
        if (source.command === undefined)
          throw new Error("ticket-source-not-configured");
        const read = await ticketText(source.command, { ticketId, signal });
        if (read.kind === "failed") throw new Error("ticket-not-available");
        await check({ ticketId, ticket: read.text, signal });
      }
      return [...waiting.keys()];
    },
    skipped: () =>
      [...waiting].map(([ticketId, dependencies]) => ({
        ticketId,
        reason: "ticket-dependency-open",
        dependencies,
      })),
  };
}
