import type ts from "typescript";
import type { DependencyPolicy, ReservedMembers } from "./dependency-policy.ts";
import { takenMembers } from "./member-uses.ts";
import { visitValueNodes } from "./value-nodes.ts";

export interface ReservedFinding {
  readonly rule: "reserved-member";
  readonly file: string;
  readonly line: number;
  readonly member: string;
}

interface Owner {
  readonly member: string;
  readonly users: readonly string[];
}

type Owners = ReadonlyMap<ts.Declaration, Owner>;

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
  const owners: Owners = new Map(
    reserved.members.flatMap((entry) => entryOwners(program, { entry, files })),
  );
  if (owners.size === 0) return [];
  return files
    .filter((file) => !reserved.exempt.includes(policy.roles[file] ?? ""))
    .flatMap((file) => fileFindings(program, { file, owners }));
}

function entryOwners(
  program: ts.Program,
  context: {
    readonly entry: ReservedMembers;
    readonly files: readonly string[];
  },
): [ts.Declaration, Owner][] {
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
    return declarations.map((declaration): [ts.Declaration, Owner] => [
      declaration,
      { member: `${entry.type}.${name}`, users: entry.users },
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

function fileFindings(
  program: ts.Program,
  inspection: { readonly file: string; readonly owners: Owners },
): ReservedFinding[] {
  const { file, owners } = inspection;
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`missing-reserved-source: ${file}`);
  if (source.isDeclarationFile) return [];
  const checker = program.getTypeChecker();
  const findings: ReservedFinding[] = [];
  visitValueNodes(source, (node) => {
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push(
      ...takenMembers(node, checker)
        .flatMap((member) => member.declarations ?? [])
        .flatMap((declaration) => owners.get(declaration) ?? [])
        .filter((owner) => !owner.users.includes(file))
        .map((owner) => ({
          rule: "reserved-member" as const,
          file,
          line,
          member: owner.member,
        })),
    );
  });
  return findings;
}
