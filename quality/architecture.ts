import type ts from "typescript";
import type { DependencyPolicy } from "./dependency-policy.ts";
import { checkDependencies } from "./dependency-policy.ts";
import { dependencyGraph } from "./dependency-graph.ts";
import { inspectEffects } from "./effects.ts";

export function checkArchitecture(
  program: ts.Program,
  policy: DependencyPolicy,
): void {
  const graph = dependencyGraph(program);
  checkDependencies(graph, policy);
  const restricted = graph.files.filter((file) =>
    ["pure", "workflow"].includes(policy.roles[file] ?? ""),
  );
  const findings = inspectEffects(program, restricted);
  if (findings.length > 0)
    throw new Error(`restricted-effect:\n${JSON.stringify(findings, null, 2)}`);
}
