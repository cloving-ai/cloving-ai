import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import proposal from "./module-policy.json" with { type: "json" };
import type { DependencyPolicy } from "./dependency-policy.ts";
import { mapModules } from "./module-mapping.ts";

export function proposedModulePolicy(directory: string): DependencyPolicy {
  const located = (file: string): string =>
    file.startsWith("node:") ? file : resolve(directory, file);
  const roles = Object.fromEntries(
    Object.entries(proposal.roles).map(([file, role]) => [located(file), role]),
  );
  return {
    roles,
    allowed: proposal.allowed,
    forbiddenReachability: proposal.forbiddenReachability,
    reserved: {
      members: proposal.reserved.members.map((entry) => ({
        ...entry,
        file: located(entry.file),
        users: entry.users.map(located),
      })),
      names: proposal.reserved.names.map((entry) => ({
        ...entry,
        file: located(entry.file),
        users: entry.users.map(located),
      })),
      imports: Object.fromEntries(
        Object.entries(proposal.reserved.imports).map(([target, importers]) => [
          located(target),
          importers.map(located),
        ]),
      ),
      exempt: proposal.reserved.exempt,
    },
  };
}

export function admittedModulePolicy(
  directory: string,
  candidate: {
    readonly files: readonly string[];
    readonly roles: Readonly<Record<string, string>>;
  },
): DependencyPolicy {
  const installed = proposedModulePolicy(directory);
  const inventory = candidate.files.map((file) => relative(directory, file));
  const roles: Readonly<Record<string, string>> = proposal.roles;
  const paths: Readonly<Record<string, string>> = proposal.automaticPaths;
  for (const [file, role] of Object.entries(candidate.roles)) {
    if (!inventory.includes(file) && roles[file] !== role)
      throw new Error(`mapping-policy-change: ${file}`);
    if (roles[file] === undefined && !file.startsWith(paths[role] ?? "/"))
      throw new Error(`mapping-requires-review: ${file}`);
  }
  const mapped = mapModules(inventory, {
    proposal: Object.fromEntries(
      Object.entries(candidate.roles).filter(([file]) =>
        inventory.includes(file),
      ),
    ),
    policy: {
      accepted: Object.fromEntries(
        Object.entries(roles).filter(([file]) => inventory.includes(file)),
      ),
      automaticRoles: Object.keys(paths),
    },
  });
  return {
    ...installed,
    roles: {
      ...installed.roles,
      ...Object.fromEntries(
        Object.entries(mapped).map(([file, role]) => [
          resolve(directory, file),
          role,
        ]),
      ),
    },
  };
}

export async function readProposedRoles(
  directory: string,
): Promise<Readonly<Record<string, string>>> {
  const text = await readFile(
    join(directory, "quality/module-policy.json"),
    "utf8",
  ).catch(() => null);
  if (text === null) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("roles" in value))
    throw new Error("invalid-module-proposal");
  const roles: unknown = value.roles;
  if (!roles || typeof roles !== "object")
    throw new Error("invalid-module-proposal");
  const entries = Object.entries(roles);
  if (entries.some(([, role]) => typeof role !== "string"))
    throw new Error("invalid-module-proposal");
  return Object.fromEntries(
    entries.map(([file, role]) => [file, String(role)]),
  );
}
