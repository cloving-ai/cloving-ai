import { join } from "node:path";
import { runScenario } from "../src/testing.ts";
import type { ProtectedResult } from "../src/step-bridge.ts";
import { withFiles } from "./quality/files-fixture.ts";

export const pollingDeclaration = {
  workflow: {
    workflowId: "approval",
    effectLimit: 30,
    capabilities: ["command"],
    commands: ["approval-status"],
    input: { maximumBytes: 1024, fields: { request: { type: "string" } } },
  },
  methods: { command: ["run:approval-status"] },
} as const;

export const pollingWorkflow = `import { runCommand, sleep } from "cloving/workflows";

export async function approval(input: {
  cycleId: string;
  input: { request: string };
}) {
  "use workflow";
  for (let round = 1; round <= 30; round += 1) {
    const result = await runCommand({
      scope: { phase: "approval", operation: "check", round },
      name: "approval-status",
      input: { request: input.input.request },
    });
    if (result.kind !== "completed")
      return blocked(input.cycleId, result.reason ?? result.kind);
    let response: unknown = null;
    try {
      if (result.result !== null) response = JSON.parse(result.result);
    } catch {
      response = null;
    }
    if (response === null || typeof response !== "object" || Array.isArray(response)
      || !("ready" in response) || typeof response.ready !== "boolean")
      return blocked(input.cycleId, "external-condition-invalid-result");
    if (response.ready)
      return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "external-condition-ready" };
    if (round < 30) await sleep({ seconds: 60 });
  }
  return blocked(input.cycleId, "external-condition-timeout");
}

function blocked(cycleId: string, reason: string) {
  return { kind: "blocked", cycleId, reason, evidenceId: "approval-status" };
}
`;

export function completedCheck(result: string | null): ProtectedResult {
  return { kind: "completed", operationId: "check", receipt: null, result };
}

export function pollingScenario(
  results: readonly ProtectedResult[],
  options: {
    readonly maximumChecks?: number;
    readonly effectLimit?: number;
  } = {},
) {
  const bound = String(options.maximumChecks ?? 30);
  const source = pollingWorkflow
    .replace("round <= 30", "round <= " + bound)
    .replace("round < 30", "round < " + bound);
  return withFiles(
    { "approval.ts": source },
    async (root) =>
      await runScenario({
        workflow: join(root, "approval.ts"),
        exportName: "approval",
        input: { cycleId: "cycle", input: { request: "merge-request-1" } },
        effectLimit: options.effectLimit ?? 30,
        effects: { "command run:approval-status": results },
      }),
  );
}
