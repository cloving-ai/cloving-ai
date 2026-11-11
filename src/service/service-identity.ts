import type { RestartPort } from "../restart-request.ts";
import type { TurnRecoveries } from "../turn-recovery.ts";
import type { RecordedSource } from "../project-settings.ts";

export interface ServiceIdentity {
  readonly version?: string;
  readonly commit?: string | null;
  readonly startedAt?: string;
  readonly restart?: RestartPort;
  readonly settingSources?: Readonly<Record<string, RecordedSource>>;
  readonly turnRecovery?: Pick<TurnRecoveries, "fields">;
}

export function serviceIdentity(options: ServiceIdentity): ServiceIdentity {
  return Object.fromEntries(
    (
      [
        "version",
        "commit",
        "startedAt",
        "restart",
        "settingSources",
        "turnRecovery",
      ] as const
    ).flatMap((name) =>
      options[name] === undefined ? [] : [[name, options[name]]],
    ),
  );
}
