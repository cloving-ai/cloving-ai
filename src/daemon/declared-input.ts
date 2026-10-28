import { createHash } from "node:crypto";
import type { Fields } from "../protocol.ts";
import type { ResolutionRequest } from "../service/registry.ts";

export function declaredInput(
  repository: string,
  request: Pick<ResolutionRequest, "commandId" | "submission">,
): Fields {
  const digest = createHash("sha256").update(request.commandId).digest("hex");
  return {
    cycleId: `task-${digest.slice(0, 12)}`,
    repository,
    input: request.submission,
  };
}
