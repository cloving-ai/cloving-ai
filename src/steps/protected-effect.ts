import {
  isStepBridge,
  stepBridgeKey,
  type ProtectedRequest,
  type ProtectedResult,
} from "../step-bridge.ts";

export async function protectedEffect(
  request: ProtectedRequest,
): Promise<ProtectedResult> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge))
    return { kind: "unavailable", reason: "cloving-host-unavailable" };
  return await bridge.effect(request);
}
