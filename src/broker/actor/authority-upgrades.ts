import { loadDecided } from "../../storage/decision-snapshots.ts";
import { loadSnapshot } from "../../storage/domain-rows.ts";
import { upgradeDecisions } from "../decision-upgrade.ts";
import { upgradeEffects } from "../effect-upgrade.ts";

const upgrades = [
  { from: "adopted", load: loadSnapshot, apply: upgradeDecisions },
  { from: "decided", load: loadDecided, apply: upgradeEffects },
] as const;

export type UpgradeStep = (typeof upgrades)[number];

export function upgradeSteps(kind: string): readonly UpgradeStep[] {
  const first = upgrades.findIndex((step) => step.from === kind);
  return first === -1 ? [] : upgrades.slice(first);
}
