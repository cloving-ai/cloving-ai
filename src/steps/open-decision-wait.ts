import {
  isStepBridge,
  stepBridgeKey,
  type GateRequest,
  type DecisionWait,
} from "../step-bridge.ts";

export async function openDecisionWait(
  request: GateRequest,
): Promise<DecisionWait> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge) || bridge.waitForDecision === undefined)
    throw new Error("cloving-host-unavailable");
  return await bridge.waitForDecision(request);
}
