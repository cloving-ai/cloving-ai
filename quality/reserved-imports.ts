import type { DependencyGraph } from "./dependency-graph.ts";
import type { DependencyPolicy } from "./dependency-policy.ts";

export function checkReservedImports(
  graph: DependencyGraph,
  policy: DependencyPolicy,
): void {
  const reserved = policy.reserved;
  if (!reserved) return;
  const offending = graph.edges.find(
    (edge) =>
      edge.kind === "value" &&
      Object.hasOwn(reserved.imports, edge.target) &&
      !reserved.exempt.includes(policy.roles[edge.from] ?? "") &&
      !reserved.imports[edge.target]?.includes(edge.from),
  );
  if (offending)
    throw new Error(
      `reserved-import: ${offending.from} -> ${offending.target}`,
    );
}
