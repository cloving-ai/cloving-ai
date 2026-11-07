import type { DaemonSettings } from "./daemon-adapters.ts";
import type { HostPorts } from "../service/service.ts";
import { treeSweep } from "./tree-sweep.ts";
import { authorityRuns, recordRetention } from "./record-sweep.ts";
import {
  bundleSweep,
  unfinishedPins,
  type CurrentBundle,
} from "./bundle-sweep.ts";
import { defaultRetention } from "../record-retention.ts";

export async function retentionLoop(
  settings: DaemonSettings,
  resources: {
    readonly current: CurrentBundle;
    readonly ports: Promise<HostPorts>;
  },
) {
  const ports = await resources.ports;
  const sweep = {
    directory: settings.directory,
    retention: settings.retention ?? defaultRetention,
    now: settings.retentionClock ?? Date.now,
    log: (line: string) => process.stderr.write(line),
  };
  return recordRetention({
    ...sweep,
    runs: authorityRuns(ports),
    trees: treeSweep({
      ...sweep,
      runs: authorityRuns(ports),
      repository: settings.repository,
      gh: settings.githubCommand ?? ["gh"],
    }),
    bundles: bundleSweep({
      ...sweep,
      current: resources.current,
      pinned: unfinishedPins({
        state: ports.state,
        manifest: ports.workflow.manifest,
      }),
    }),
  });
}
