import type { LocalCommands } from "./command-settings.ts";
import type { Fields } from "./protocol.ts";
import type { TokenPrices } from "./token-prices.ts";
import type { TurnProfiles } from "./turn-profile.ts";

export interface RedGreenSettings {
  readonly test: readonly string[];
  readonly testFiles: readonly string[];
  readonly prepare?: readonly string[];
  readonly assertionPattern?: string;
  readonly skipPattern?: string;
}

export interface WorkflowQueueSetting {
  readonly state?: "on" | "off";
  readonly everySeconds?: number;
  readonly lanes?: number;
  readonly workingLanes?: number;
}

export type QueuesSetting = Readonly<Record<string, WorkflowQueueSetting>>;

export type SettingValue =
  | null
  | string
  | number
  | readonly string[]
  | TurnProfiles
  | TokenPrices
  | RedGreenSettings
  | LocalCommands
  | QueuesSetting
  | Readonly<Record<string, Fields>>;

export function encodedSettingValue(value: SettingValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
