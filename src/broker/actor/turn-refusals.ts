import { isInstant } from "../../authority/instants.ts";
import type { AuthorityCommand } from "../../authority/transitions.ts";
import { operationDigest } from "../operation-digest.ts";

export interface Fresh {
  readonly command: AuthorityCommand;
  readonly recordedAt: string;
  readonly given: number | undefined;
  readonly epoch: number;
}

type Rule = (fresh: Fresh) => boolean;

const expiryPrefix = "expire-lease:";

function scanned(command: AuthorityCommand): boolean {
  const expiry = command.kind === "expire-lease";
  if (!expiry) return !command.commandId.startsWith(expiryPrefix);
  const digest = operationDigest(String(command.operationId));
  const generation = String(command.leaseGeneration);
  return command.commandId === `${expiryPrefix}${digest}:${generation}`;
}

const planKinds = ["record-dispatch", "grant-lease", "record-outcome"];
const planPrefixes = ["lease:", "outcome:", "dispatch:"];
const workerKinds = ["request-effect", "report-effect"];
const timedKinds = [...workerKinds, "expire-lease"];

const rules: readonly (readonly [string, Rule])[] = [
  ["stale-epoch", ({ given, epoch }) => given !== undefined && given !== epoch],
  [
    "delivery-owned-command",
    ({ command }) =>
      planKinds.includes(command.kind) ||
      planPrefixes.some((prefix) => command.commandId.startsWith(prefix)),
  ],
  ["delivery-owned-command", ({ command }) => !scanned(command)],
  [
    "missing-epoch",
    ({ command, given }) =>
      workerKinds.includes(command.kind) && given === undefined,
  ],
  [
    "invalid-recorded-time",
    ({ command, recordedAt }) =>
      timedKinds.includes(command.kind) && !isInstant(recordedAt),
  ],
];

export function refusalOf(fresh: Fresh): string | undefined {
  return rules.find(([, applies]) => applies(fresh))?.[0];
}
