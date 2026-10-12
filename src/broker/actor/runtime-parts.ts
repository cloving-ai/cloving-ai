import {
  createRuntime,
  type ActorClass,
  type Database,
  type InstrumentationEvent,
  type SolidObjectsConfiguration,
  type SolidObjectsRuntime,
} from "solid-objects";
import { persistChange } from "../../storage/domain-changes.ts";
import { persistAction } from "./authority-actor.ts";
import { brokerAuthorization } from "./authority-policy.ts";
import { librarySettings, type AuthorityTiming } from "./authority-settings.ts";
import type { StrandingWatchdog } from "./authority-watchdog.ts";

export function failureCounter(): (operationId: string) => number {
  const counts = new Map<string, number>();
  return (operationId) => {
    const count = (counts.get(operationId) ?? 0) + 1;
    counts.set(operationId, count);
    return count;
  };
}

export function wallClock(): string {
  return new Date().toISOString();
}

export function runtimeSettings(parts: {
  readonly timing: AuthorityTiming;
  readonly options: {
    readonly log?: (line: string) => void;
    readonly instrumentation?: (event: InstrumentationEvent) => void;
  };
  readonly broker: object;
  readonly watchdog: StrandingWatchdog;
}): Partial<SolidObjectsConfiguration> {
  const { timing, options, broker, watchdog } = parts;
  return {
    ...librarySettings(timing, options.log),
    ...brokerAuthorization(broker),
    instrumentation: (event) => {
      watchdog.observe(event, Date.now());
      options.instrumentation?.(event);
    },
  };
}

export function registeredRuntime(registration: {
  readonly database: Database;
  readonly actor: ActorClass;
  readonly settings: Partial<SolidObjectsConfiguration>;
}): SolidObjectsRuntime {
  const { database, actor, settings } = registration;
  const runtime = createRuntime({ database, ...settings });
  runtime.register(actor);
  runtime.registerCommitAction(persistAction, (change, context) =>
    persistChange(change, context.connection),
  );
  return runtime;
}
