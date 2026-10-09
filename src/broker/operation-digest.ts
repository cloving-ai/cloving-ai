import { createHash } from "node:crypto";

export function operationDigest(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex");
}
