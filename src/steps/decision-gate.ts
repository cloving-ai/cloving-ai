import {
  isStepBridge,
  stepBridgeKey,
  type GateRequest,
  type GateResult,
} from "../step-bridge.ts";

export async function decisionGate(request: GateRequest): Promise<GateResult> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge))
    return { kind: "unavailable", reason: "cloving-host-unavailable" };
  return await bridge.gate(request);
}
