import type { SolidObjectsConfiguration } from "solid-objects";
import { recoveryBound } from "../../authority/commands.ts";
import { lineLogger } from "./authority-logger.ts";
import { commandLimits } from "../../command-settings.ts";

export interface AuthorityTiming {
  readonly leaseMilliseconds: number;
  readonly renewalMilliseconds: number;
  readonly heartbeatMilliseconds: number;
  readonly aliveThresholdMilliseconds: number;
  readonly cleanupIntervalMilliseconds: number;
  readonly callTimeoutMilliseconds: number;
  readonly messageRetentionMilliseconds: number;
  readonly retentionIntervalMilliseconds: number;
  readonly shutdownMilliseconds: number;
}

export const authorityTiming: AuthorityTiming = {
  leaseMilliseconds: 2_000,
  renewalMilliseconds: 500,
  heartbeatMilliseconds: 1_000,
  aliveThresholdMilliseconds: 3_000,
  cleanupIntervalMilliseconds: 1_000,
  callTimeoutMilliseconds: 10_000,
  messageRetentionMilliseconds: 30 * 86_400_000,
  retentionIntervalMilliseconds: 3_600_000,
  shutdownMilliseconds: 10_000,
};

export interface EffectSettings {
  readonly capacity: number;
  readonly leaseMilliseconds: number;
  readonly adapterMilliseconds: number;
  readonly resultBytes: number;
  readonly deliveryAttempts: number;
  readonly stopLimit: number;
  readonly recoveryLimit: number;
}

export interface PlanSettings extends EffectSettings {
  readonly stopSupported: boolean;
}

export const effectSettings: PlanSettings = {
  capacity: 4,
  leaseMilliseconds: 600_000,
  adapterMilliseconds: 30_000,
  resultBytes: 262_144,
  deliveryAttempts: 2,
  stopLimit: 3,
  recoveryLimit: 3,
  stopSupported: false,
};

const maximumCapacity = 8;

export function effectConfiguration(options: {
  readonly effects?: Partial<EffectSettings>;
  readonly delivery?: { readonly stop?: unknown };
}): PlanSettings {
  const settings = {
    ...effectSettings,
    ...options.effects,
    stopSupported: options.delivery?.stop !== undefined,
  };
  const positive = [
    settings.capacity,
    settings.leaseMilliseconds,
    settings.adapterMilliseconds,
    settings.resultBytes,
    settings.deliveryAttempts,
    settings.stopLimit,
    settings.recoveryLimit,
  ].every((value) => Number.isInteger(value) && value >= 1);
  const bounded =
    settings.capacity <= maximumCapacity &&
    settings.recoveryLimit <= recoveryBound;
  if (!positive || !bounded) throw new Error("invalid-effect-settings");
  return settings;
}

function standardError(line: string): void {
  process.stderr.write(line);
}

export function librarySettings(
  timing: AuthorityTiming,
  log: ((line: string) => void) | undefined,
): Partial<SolidObjectsConfiguration> {
  return {
    tableNamePrefix: "solid_",
    maxAttempts: 1,
    maxActivationDurationMilliseconds: 50,
    maxPayloadBytes: 900_000 + commandLimits.stdoutBytes * 6,
    maxResultBytes: 900_000 + commandLimits.stdoutBytes * 6,
    logger: lineLogger(log ?? standardError),
    leaseDurationMilliseconds: timing.leaseMilliseconds,
    leaseRenewalIntervalMilliseconds: timing.renewalMilliseconds,
    processHeartbeatIntervalMilliseconds: timing.heartbeatMilliseconds,
    processAliveThresholdMilliseconds: timing.aliveThresholdMilliseconds,
    deadProcessCleanupIntervalMilliseconds: timing.cleanupIntervalMilliseconds,
    messageRetentionMilliseconds: timing.messageRetentionMilliseconds,
    retentionIntervalMilliseconds: timing.retentionIntervalMilliseconds,
    shutdownTimeoutMilliseconds: timing.shutdownMilliseconds,
  };
}
