import { createHook } from "workflow";
import type { DecisionResult, GateRequest } from "../step-bridge.ts";
import { openDecisionWait } from "./decision-gate.ts";

export async function waitForDecision(
  request: GateRequest,
): Promise<DecisionResult> {
  const wait = await openDecisionWait(request);
  if ("decision" in wait) return wait;
  using hook = createHook<DecisionResult>({ token: wait.token });
  return await hook;
}
