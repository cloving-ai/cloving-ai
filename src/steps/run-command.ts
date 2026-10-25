import {
  isStepBridge,
  stepBridgeKey,
  type CommandRequest,
  type ProtectedResult,
} from "../step-bridge.ts";

export async function runCommand(
  request: CommandRequest,
): Promise<ProtectedResult> {
  "use step";
  const bridge: unknown = Reflect.get(globalThis, Symbol.for(stepBridgeKey));
  if (!isStepBridge(bridge))
    return { kind: "unavailable", reason: "cloving-host-unavailable" };
  return await bridge.effect({
    scope: request.scope,
    capability: "command",
    method: `run:${request.name}`,
    target: request.name,
    payload: JSON.stringify(request.input),
    units: 1,
  });
}
