import {
  isStepBridge,
  stepBridgeKey,
  type RunWaitOutcome,
  type RunWaitRequest,
} from "../step-bridge.ts";

export async function waitForRun(
  request: RunWaitRequest,
): Promise<RunWaitOutcome> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge) || bridge.waitForRun === undefined)
    throw new Error("cloving-host-unavailable");
  return await bridge.waitForRun(request);
}

waitForRun.maxRetries = 86401;
