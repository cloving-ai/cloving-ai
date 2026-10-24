import {
  isStepBridge,
  stepBridgeKey,
  type HandoffRequest,
} from "../step-bridge.ts";

export async function handoff(request: HandoffRequest): Promise<string> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge) || bridge.handoff === undefined)
    throw new Error("cloving-host-unavailable");
  const result = await bridge.handoff(request);
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  if (result.result === null) throw new Error("handoff-result-missing");
  return result.result;
}
