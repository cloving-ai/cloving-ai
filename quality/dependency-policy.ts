import type { DependencyGraph, DependencyEdge } from "./dependency-graph.ts";

export interface DependencyPolicy {
  readonly roles: Readonly<Record<string, string>>;
  readonly allowed: Readonly<Record<string, readonly string[]>>;
  readonly forbiddenReachability: Readonly<Record<string, readonly string[]>>;
}

export function checkDependencies(
  graph: DependencyGraph,
  policy: DependencyPolicy,
): void {
  if (graph.files.length === 0 || Object.keys(policy.roles).length === 0)
    throw new Error("empty-dependency-policy");
  for (const file of graph.files) {
    if (!policy.roles[file]) throw new Error(`unmapped-module: ${file}`);
  }
  for (const edge of graph.edges) checkEdge(edge, policy);
  const outgoing = new Map(
    graph.files.map((file) => [
      file,
      graph.edges
        .filter((edge) => edge.from === file)
        .map((edge) => edge.target),
    ]),
  );
  for (const file of graph.files) checkPaths(file, { outgoing, policy });
}

function checkEdge(edge: DependencyEdge, policy: DependencyPolicy): void {
  const sourceRole = policy.roles[edge.from];
  const targetRole = policy.roles[edge.target];
  if (!sourceRole || !targetRole)
    throw new Error(`unmapped-dependency: ${edge.from} -> ${edge.target}`);
  if (!policy.allowed[sourceRole]?.includes(targetRole))
    throw new Error(`forbidden-dependency: ${edge.from} -> ${edge.target}`);
}

function checkPaths(
  origin: string,
  graph: {
    readonly outgoing: ReadonlyMap<string, readonly string[]>;
    readonly policy: DependencyPolicy;
  },
): void {
  const { outgoing, policy } = graph;
  const visited = new Set<string>();
  const forbidden =
    policy.forbiddenReachability[policy.roles[origin] ?? ""] ?? [];
  function visit(file: string, ancestors: readonly string[]): void {
    if (ancestors.includes(file))
      throw new Error(`dependency-cycle: ${[...ancestors, file].join(" -> ")}`);
    if (visited.has(file)) return;
    if (forbidden.includes(policy.roles[file] ?? ""))
      throw new Error(`forbidden-reachability: ${origin} -> ${file}`);
    visited.add(file);
    for (const target of outgoing.get(file) ?? [])
      visit(target, [...ancestors, file]);
  }
  visit(origin, []);
}
