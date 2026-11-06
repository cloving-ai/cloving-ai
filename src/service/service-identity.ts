import type { RestartPort } from "../restart-request.ts";

export interface ServiceIdentity {
  readonly version?: string;
  readonly commit?: string | null;
  readonly startedAt?: string;
  readonly restart?: RestartPort;
}

export function serviceIdentity(options: ServiceIdentity): ServiceIdentity {
  return Object.fromEntries(
    (["version", "commit", "startedAt", "restart"] as const).flatMap((name) =>
      options[name] === undefined ? [] : [[name, options[name]]],
    ),
  );
}
