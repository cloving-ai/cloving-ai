import { join } from "node:path";

export interface HostPlace {
  readonly directory: string;
  readonly concurrency: number;
  readonly leaseSeconds?: number;
}

export const ownershipLeaseSeconds = 15;

export function worldDirectory(directory: string): string {
  return join(directory, "world");
}

export function hostEnvironment(
  place: HostPlace,
): Readonly<Record<string, string>> {
  return {
    WORKFLOW_TARGET_WORLD: "local",
    WORKFLOW_LOCAL_DATA_DIR: worldDirectory(place.directory),
    WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:1",
    WORKFLOW_LOCAL_QUEUE_CONCURRENCY: String(place.concurrency),
    WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: String(
      place.leaseSeconds ?? ownershipLeaseSeconds,
    ),
  };
}
