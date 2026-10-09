import type { DevelopmentInput } from "../workflow-contracts.ts";
import { validateDevelopmentInput } from "../workflow-contracts.ts";

export type CycleLoad =
  | {
      readonly kind: "unavailable";
      readonly reason: "cloving-host-unavailable";
      readonly cycleId: string;
    }
  | { readonly kind: "invalid"; readonly reason: "invalid-development-input" };

export async function loadCycle(input: DevelopmentInput): Promise<CycleLoad> {
  "use step";
  return Promise.resolve<CycleLoad>(
    validateDevelopmentInput(input).kind === "invalid"
      ? { kind: "invalid", reason: "invalid-development-input" }
      : {
          kind: "unavailable",
          reason: "cloving-host-unavailable",
          cycleId: input.cycleId,
        },
  );
}
