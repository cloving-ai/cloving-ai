import type ts from "typescript";
import type { DependencyPolicy } from "./dependency-policy.ts";
import { checkDependencies } from "./dependency-policy.ts";
import { dependencyGraph } from "./dependency-graph.ts";
import { inspectEffects } from "./effects.ts";
import { inspectNetworkGlobals } from "./network-globals.ts";
import { checkReservedImports } from "./reserved-imports.ts";
import { inspectReservedMembers } from "./reserved-members.ts";
import { inspectReservedNames } from "./reserved-names.ts";

export function checkArchitecture(
  program: ts.Program,
  policy: DependencyPolicy,
): void {
  const graph = dependencyGraph(program);
  checkDependencies(graph, policy);
  checkReservedImports(graph, policy);
  rejectFindings(
    "reserved-member",
    inspectReservedMembers(program, { files: graph.files, policy }),
  );
  rejectFindings(
    "reserved-name",
    inspectReservedNames(program, { files: graph.files, policy }),
  );
  const withRole = (roles: readonly string[]): string[] =>
    graph.files.filter((file) => roles.includes(policy.roles[file] ?? ""));
  rejectFindings(
    "network-global",
    inspectNetworkGlobals(
      program,
      withRole(["broker", "storage", "service", "step", "host-bridge"]),
    ),
  );
  rejectFindings(
    "restricted-effect",
    inspectEffects(program, withRole(["pure", "workflow"])),
  );
}

function rejectFindings(rule: string, findings: readonly unknown[]): void {
  if (findings.length > 0)
    throw new Error(`${rule}:\n${JSON.stringify(findings, null, 2)}`);
}
