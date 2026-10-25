import type { ServiceContext } from "./replies.ts";
import type { Fields } from "../protocol.ts";
import type { OperationView } from "../broker/actor/authority.ts";

export async function commandFields(
  context: ServiceContext,
  operations: readonly OperationView[],
): Promise<Fields> {
  const effects = operations
    .filter((operation) => operation.capability === "command")
    .map((operation) => ({
      operationId: operation.operationId,
      name: operation.method.slice(4),
      state: operation.status,
      exitCode: null,
      durationMilliseconds: null,
    }));
  if (effects.length === 0) return {};
  return {
    commandEffects: (await context.commandEffects?.(effects)) ?? effects,
  };
}
