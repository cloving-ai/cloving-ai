export interface WorkflowDiscoveryIdentity {
  readonly queue?: boolean;
  readonly baseName: string;
  readonly workflowId: string | undefined;
  readonly functionNames: readonly string[];
}

export type WorkflowConflictCode = "workflow-conflict";

function identityKeys(identity: WorkflowDiscoveryIdentity): readonly string[] {
  return [
    `base:${identity.baseName}`,
    ...(identity.workflowId === undefined ? [] : [`id:${identity.workflowId}`]),
    ...identity.functionNames.map((name) => `function:${name}`),
  ];
}

export function workflowConflicts(
  candidates: readonly WorkflowDiscoveryIdentity[],
): readonly (readonly WorkflowConflictCode[])[] {
  const keys = candidates.map(identityKeys);
  const counts = new Map<string, number>();
  for (const names of keys) {
    for (const name of new Set(names))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return keys.map((names) => {
    const codes: WorkflowConflictCode[] = [];
    if (names.some((name) => (counts.get(name) ?? 0) > 1))
      codes.push("workflow-conflict");
    return codes;
  });
}
