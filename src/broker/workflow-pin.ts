import { createHash } from "node:crypto";
import { pinnedIdentity } from "../execution-pin.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";

export function workflowPin(manifest: ExecutionManifest): string {
  return `sha256:${createHash("sha256").update(pinnedIdentity(manifest)).digest("hex")}`;
}
