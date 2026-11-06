import { defaultChainLimit } from "./authority/handoff-chain.ts";
import type { WorkflowDeclaration } from "./workflow-declaration.ts";

export interface WorkflowLimits {
  readonly effects: number;
  readonly chain: number;
}

export const defaultWorkflowLimits: WorkflowLimits = { effects: 100, chain: 5 };

export type WorkflowLimitCode =
  "effect-limit-above-maximum" | "chain-limit-above-maximum";

export function workflowLimitRefusals(
  declaration: Pick<WorkflowDeclaration, "effectLimit" | "chainLimit">,
  limits: WorkflowLimits = defaultWorkflowLimits,
): readonly WorkflowLimitCode[] {
  const codes: WorkflowLimitCode[] = [];
  if (declaration.effectLimit > limits.effects)
    codes.push("effect-limit-above-maximum");
  if ((declaration.chainLimit ?? 0) > limits.chain)
    codes.push("chain-limit-above-maximum");
  return codes;
}

export function chainLimitWithin(
  declaration: Pick<WorkflowDeclaration, "chainLimit">,
  limits: WorkflowLimits = defaultWorkflowLimits,
): Pick<WorkflowDeclaration, "chainLimit"> {
  if (declaration.chainLimit !== undefined)
    return { chainLimit: declaration.chainLimit };
  if (limits.chain >= defaultChainLimit) return {};
  return { chainLimit: limits.chain };
}

function limit(
  variables: Readonly<Record<string, string | undefined>>,
  setting: {
    readonly variable: string;
    readonly fallback: number;
    readonly minimum: number;
    readonly maximum: number;
  },
): number {
  const value = variables[setting.variable];
  if (value === undefined) return setting.fallback;
  const number = Number(value);
  const whole = /^[1-9][0-9]*$/.test(value);
  if (whole && number >= setting.minimum && number <= setting.maximum)
    return number;
  throw new Error(
    `invalid-setting: ${setting.variable} must be a whole number from ${String(setting.minimum)} to ${String(setting.maximum)}`,
  );
}

export function workflowLimits(
  variables: Readonly<Record<string, string | undefined>>,
): WorkflowLimits {
  return {
    effects: limit(variables, {
      variable: "CLOVING_LIMIT_EFFECTS",
      fallback: defaultWorkflowLimits.effects,
      minimum: 1,
      maximum: 1000,
    }),
    chain: limit(variables, {
      variable: "CLOVING_LIMIT_CHAIN",
      fallback: defaultWorkflowLimits.chain,
      minimum: 2,
      maximum: 50,
    }),
  };
}
