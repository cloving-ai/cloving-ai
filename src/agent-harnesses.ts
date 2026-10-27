import { spawn } from "node:child_process";
import { createProbeRunner } from "./cli/probe-command.ts";
import {
  discoverHarnesses as discover,
  probeHarness as probe,
  type HarnessOptions,
} from "./cli/harness-probes.ts";
export type {
  HarnessEntry,
  HarnessDiscovery,
  HarnessOptions,
} from "./cli/harness-probes.ts";

const runner = createProbeRunner({
  spawn: (input) => spawn(input.executable, input.arguments, input.options),
  kill: (identifier, signal) => process.kill(identifier, signal),
});
export function discoverHarnesses(options: HarnessOptions = {}) {
  return discover({ ...options, probe: runner });
}
export function probeHarness(target: string, options: HarnessOptions = {}) {
  return probe(target, { ...options, probe: runner });
}
