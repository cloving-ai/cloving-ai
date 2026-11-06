import type { RestartPort } from "../restart-request.ts";
import type { RecordedSource } from "../project-settings.ts";

export interface ServiceIdentity {
  readonly version?: string;
  readonly commit?: string | null;
  readonly startedAt?: string;
  readonly restart?: RestartPort;
  readonly settingSources?: Readonly<Record<string, RecordedSource>>;
}

export function serviceIdentity(options: ServiceIdentity): ServiceIdentity {
  return Object.fromEntries(
    (
      ["version", "commit", "startedAt", "restart", "settingSources"] as const
    ).flatMap((name) =>
      options[name] === undefined ? [] : [[name, options[name]]],
    ),
  );
}
