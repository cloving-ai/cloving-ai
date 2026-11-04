import {
  isStepBridge,
  stepBridgeKey,
  type RunWaitCheck,
  type RunWaitProgress,
} from "../step-bridge.ts";

export async function checkRunWait(
  request: RunWaitCheck,
): Promise<RunWaitProgress> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge) || bridge.checkRunWait === undefined)
    throw new Error("cloving-host-unavailable");
  return await bridge.checkRunWait(request);
}

checkRunWait.maxRetries = 47;

export function runWaitDate(milliseconds: number): Date {
  return new Date(milliseconds);
}
