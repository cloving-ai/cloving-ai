import {
  upgradeCommandWaits,
  upgradeCommandWaitChecks,
} from "../command-wait-restore.ts";
import {
  loadDecided,
  loadEffected,
  loadWaiting,
  loadCurrent,
} from "../../storage/decision-snapshots.ts";
import { loadSnapshot } from "../../storage/domain-rows.ts";
import { upgradeDecisions } from "../decision-upgrade.ts";
import {
  upgradeEffects,
  upgradeEventIndexes,
  upgradeSpendingIndexes,
} from "../effect-upgrade.ts";

const upgrades = [
  { from: "adopted", load: loadSnapshot, apply: upgradeDecisions },
  { from: "decided", load: loadDecided, apply: upgradeEffects },
  { from: "effected", load: loadEffected, apply: upgradeCommandWaits },
  { from: "waiting", load: loadWaiting, apply: upgradeCommandWaitChecks },
  { from: "checked", load: loadCurrent, apply: upgradeSpendingIndexes },
  { from: "indexed", load: loadCurrent, apply: upgradeEventIndexes },
] as const;

export type UpgradeStep = (typeof upgrades)[number];

export function upgradeSteps(kind: string): readonly UpgradeStep[] {
  const first = upgrades.findIndex((step) => step.from === kind);
  return first === -1 ? [] : upgrades.slice(first);
}
