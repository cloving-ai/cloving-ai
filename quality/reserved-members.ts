import type ts from "typescript";
import type { DependencyPolicy, ReservedMembers } from "./dependency-policy.ts";
import { takenMembers } from "./member-uses.ts";
import {
  reservedUses,
  type ReservedOwner,
  type ReservedOwners,
} from "./reserved-uses.ts";

export interface ReservedFinding {
  readonly rule: "reserved-member";
  readonly file: string;
  readonly line: number;
  readonly member: string;
}

export function inspectReservedMembers(
  program: ts.Program,
  scope: {
    readonly files: readonly string[];
    readonly policy: DependencyPolicy;
  },
): ReservedFinding[] {
  const { files, policy } = scope;
  const reserved = policy.reserved;
  if (!reserved) return [];
  const checker = program.getTypeChecker();
  const owners: ReservedOwners = new Map(
    reserved.members.flatMap((entry) => entryOwners(program, { entry, files })),
  );
  return reservedUses(program, {
    files,
    roles: policy.roles,
    exempt: reserved.exempt,
    owners,
    taken: (node) => takenMembers(node, checker),
  }).map((use) => ({
    rule: "reserved-member",
    file: use.file,
    line: use.line,
    member: use.label,
  }));
}

function entryOwners(
  program: ts.Program,
  context: {
    readonly entry: ReservedMembers;
    readonly files: readonly string[];
  },
): [ts.Declaration, ReservedOwner][] {
  const { entry, files } = context;
  const source = program.getSourceFile(entry.file);
  if (!source && !entry.users.some((user) => files.includes(user))) return [];
  const properties = declaredMembers(program.getTypeChecker(), {
    source,
    type: entry.type,
  });
  const names =
    entry.members.length > 0
      ? entry.members
      : properties.map((property) => property.name);
  if (names.length === 0)
    throw new Error(`reserved-missing: ${entry.file}#${entry.type}`);
  return names.flatMap((name) => {
    const declarations =
      properties.find((property) => property.name === name)?.declarations ?? [];
    if (declarations.length === 0)
      throw new Error(`reserved-missing: ${entry.file}#${entry.type}.${name}`);
    const owner = { label: `${entry.type}.${name}`, users: entry.users };
    return declarations.map((declaration): [ts.Declaration, ReservedOwner] => [
      declaration,
      owner,
    ]);
  });
}

function declaredMembers(
  checker: ts.TypeChecker,
  declared: {
    readonly source: ts.SourceFile | undefined;
    readonly type: string;
  },
): ts.Symbol[] {
  const module =
    declared.source && checker.getSymbolAtLocation(declared.source);
  const symbol =
    module &&
    checker
      .getExportsOfModule(module)
      .find((exported) => exported.name === declared.type);
  if (!symbol) return [];
  return checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol));
}
