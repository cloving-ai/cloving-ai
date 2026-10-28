export interface WorkflowReservation {
  readonly baseName?: string;
  readonly workflowId?: string;
  readonly functionName?: string;
}

export interface WorkflowDiscoveryIdentity {
  readonly queue?: boolean;
  readonly baseName: string;
  readonly workflowId: string | undefined;
  readonly functionNames: readonly string[];
}

export type WorkflowConflictCode =
  "workflow-conflict" | "bundled-name-reserved" | "queue-workflow-conflict";

function identityKeys(identity: {
  readonly baseName?: string | undefined;
  readonly workflowId?: string | undefined;
  readonly functionNames: readonly string[];
}): readonly string[] {
  return [
    ...(identity.baseName === undefined ? [] : [`base:${identity.baseName}`]),
    ...(identity.workflowId === undefined ? [] : [`id:${identity.workflowId}`]),
    ...identity.functionNames.map((name) => `function:${name}`),
  ];
}

export function workflowConflicts(
  candidates: readonly WorkflowDiscoveryIdentity[],
  bundled: readonly WorkflowReservation[],
): readonly (readonly WorkflowConflictCode[])[] {
  const keys = candidates.map(identityKeys);
  const counts = new Map<string, number>();
  for (const names of keys) {
    for (const name of new Set(names))
      counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const reserved = new Set(
    bundled.flatMap((entry) =>
      identityKeys({
        ...entry,
        functionNames:
          entry.functionName === undefined ? [] : [entry.functionName],
      }),
    ),
  );
  const queued = candidates.filter((candidate) => candidate.queue === true);
  return keys.map((names, index) => {
    const codes: WorkflowConflictCode[] = [];
    if (queued.length > 1 && candidates[index]?.queue === true)
      codes.push("queue-workflow-conflict");
    if (names.some((name) => reserved.has(name)))
      codes.push("bundled-name-reserved");
    if (names.some((name) => (counts.get(name) ?? 0) > 1))
      codes.push("workflow-conflict");
    return codes;
  });
}
export const bundledWorkflowIds = {
  ticket: "develop-ticket",
  issue: "develop-issue",
  prompt: "develop-prompt",
  prd: "develop-prd",
} as const;
