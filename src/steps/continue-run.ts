import {
  isStepBridge,
  stepBridgeKey,
  type ContinueRunRequest,
} from "../step-bridge.ts";

export async function continueRun(
  request: ContinueRunRequest,
): Promise<string> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge) || bridge.continueRun === undefined)
    throw new Error("cloving-host-unavailable");
  const result = await bridge.continueRun(request);
  if (result.kind !== "completed")
    throw new Error(result.reason ?? result.kind);
  if (result.result === null) throw new Error("continuation-result-missing");
  return result.result;
}
