import { turnHarness, type HarnessSettings } from "../harness-defaults.ts";
import {
  reloadedSettingFields,
  type TurnSettings,
} from "../project-settings.ts";
import { record } from "../protocol.ts";
import type { SettingChanges } from "../service/workflow-reload.ts";
import { parseFallbackModels, parseTokenPrices } from "../token-prices.ts";
import { isProfilesFile, type TurnProfiles } from "../turn-profile.ts";
import { checkedProfiles } from "./worker-profile.ts";
import { queueLimitsOf, type QueueLimits } from "../queue-room.ts";

export type SettingDigests = Readonly<Record<string, string>>;

export interface ReloadedSettings {
  readonly turnSettings: TurnSettings;
  readonly settingDigests: SettingDigests;
  readonly queueLimits: QueueLimits;
  readonly queueWorkflowLimits?: Readonly<Record<string, QueueLimits>>;
}

export interface TurnSettingsSource {
  readonly current: () => TurnSettings;
  readonly replace: (next: TurnSettings) => void;
}

export function turnSettingsSource(initial: TurnSettings): TurnSettingsSource {
  let current = initial;
  return {
    current: () => current,
    replace: (next) => {
      current = next;
    },
  };
}

function turnSettingsOf(value: unknown): TurnSettings | undefined {
  const fields = record(value) ?? {};
  const profiles = { profiles: fields["profiles"] };
  if (!isProfilesFile(profiles)) return undefined;
  try {
    return {
      profiles: profiles.profiles,
      fallbackModels: parseFallbackModels(
        JSON.stringify(fields["fallbackModels"]),
      ),
      tokenPrices: parseTokenPrices(JSON.stringify(fields["tokenPrices"])),
    };
  } catch {
    return undefined;
  }
}

function digestsOf(value: unknown): SettingDigests | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const entries = Object.entries(fields);
  const digests = entries.filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return digests.length === entries.length
    ? Object.fromEntries(digests)
    : undefined;
}

function workflowLimitsOf(
  value: unknown,
): Readonly<Record<string, QueueLimits>> | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const entries = Object.entries(fields).map(
    ([id, limits]) => [id, queueLimitsOf(limits)] as const,
  );
  if (entries.some(([, limits]) => limits === undefined)) return undefined;
  return Object.fromEntries(
    entries.filter(
      (entry): entry is readonly [string, QueueLimits] =>
        entry[1] !== undefined,
    ),
  );
}

export function reloadedSettings(
  output: Readonly<Record<string, unknown>> | undefined,
): ReloadedSettings | undefined {
  const fields = output ?? {};
  const turnSettings = turnSettingsOf(fields["turnSettings"]);
  const settingDigests = digestsOf(fields["settingDigests"]);
  const queueLimits = queueLimitsOf(fields["queueLimits"]);
  const queueWorkflowLimits = workflowLimitsOf(fields["queueWorkflowLimits"]);
  if (
    fields["queueWorkflowLimits"] !== undefined &&
    queueWorkflowLimits === undefined
  )
    return undefined;
  return turnSettings === undefined ||
    settingDigests === undefined ||
    queueLimits === undefined
    ? undefined
    : {
        turnSettings,
        settingDigests,
        queueLimits,
        ...(queueWorkflowLimits === undefined ? {} : { queueWorkflowLimits }),
      };
}

function restartPart(digest: string | undefined): string | undefined {
  return digest?.split(":")[0];
}

function livePart(digest: string | undefined): string | undefined {
  return digest?.split(":")[1];
}

export function settingChanges(
  current: SettingDigests,
  next: SettingDigests,
): SettingChanges {
  const changed = [...new Set([...Object.keys(current), ...Object.keys(next)])]
    .filter((field) => current[field] !== next[field])
    .sort();
  const reloaded = (field: string): boolean =>
    field === "queues"
      ? livePart(current[field]) !== livePart(next[field])
      : reloadedSettingFields.includes(field);
  const restarted = (field: string): boolean =>
    field === "queues"
      ? restartPart(current[field]) !== restartPart(next[field])
      : !reloaded(field);
  return {
    reloadedFields: changed.filter((field) => reloaded(field)),
    restartFields: changed.filter((field) => restarted(field)),
  };
}

export function keptDigests(
  current: SettingDigests,
  change: {
    readonly digests: SettingDigests;
    readonly reloadedFields: readonly string[];
  },
): SettingDigests {
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(change.digests)
        .filter(([field]) => change.reloadedFields.includes(field))
        .map(([field, digest]) => [
          field,
          field === "queues"
            ? `${restartPart(current[field]) ?? ""}:${livePart(digest) ?? ""}`
            : digest,
        ]),
    ),
  };
}

function newHarness(
  settings: HarnessSettings & { readonly profiles?: TurnProfiles },
  profiles: TurnProfiles,
): string | undefined {
  const started = new Set(
    [{}, ...Object.values(settings.profiles ?? {})].map(
      (profile) => turnHarness(settings, profile).worker,
    ),
  );
  return Object.values(profiles)
    .map((profile) => turnHarness(settings, profile).worker)
    .find((name) => !started.has(name));
}

export function profileRefusal(
  settings: HarnessSettings & { readonly profiles?: TurnProfiles },
  turnSettings: TurnSettings,
): { readonly code: string; readonly detail: string } | undefined {
  try {
    checkedProfiles(settings, turnSettings.profiles);
  } catch (error) {
    const detail = String(Reflect.get(Object(error), "message"));
    return { code: detail.replace(/:.*$/s, ""), detail };
  }
  const added = newHarness(settings, turnSettings.profiles);
  return added === undefined
    ? undefined
    : { code: "harness-no-worker", detail: `harness-no-worker: ${added}` };
}
