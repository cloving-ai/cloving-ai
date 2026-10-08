import { resolve } from "node:path";
import proposal from "./module-policy.json" with { type: "json" };
import type { DependencyPolicy } from "./dependency-policy.ts";

export function proposedModulePolicy(directory: string): DependencyPolicy {
  const roles = Object.fromEntries(
    Object.entries(proposal.roles).map(([file, role]) => [
      file.startsWith("node:") ? file : resolve(directory, file),
      role,
    ]),
  );
  return {
    roles,
    allowed: proposal.allowed,
    forbiddenReachability: proposal.forbiddenReachability,
  };
}
