import { isStepBridge, stepBridgeKey } from "../step-bridge.ts";
import {
  isCommandWaitRequest,
  type CommandWaitRequest,
  type CommandWaitProgress,
} from "../command-wait.ts";

export async function openCommandWait(
  request: CommandWaitRequest,
): Promise<CommandWaitProgress> {
  "use step";
  if (!isCommandWaitRequest(request))
    return { kind: "refused", reason: "invalid-command-wait-request" };
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge) || bridge.openCommandWait === undefined)
    return { kind: "unavailable", reason: "cloving-host-unavailable" };
  return await bridge.openCommandWait({
    name: request.name,
    input: request.input,
  });
}

export async function checkCommandWait(request: {
  readonly name: string;
}): Promise<CommandWaitProgress> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge) || bridge.checkCommandWait === undefined)
    return { kind: "unavailable", reason: "cloving-host-unavailable" };
  return await bridge.checkCommandWait({ name: request.name });
}

openCommandWait.maxRetries = 0;
checkCommandWait.maxRetries = 0;

export function commandWaitDate(milliseconds: number): Date {
  return new Date(milliseconds);
}
