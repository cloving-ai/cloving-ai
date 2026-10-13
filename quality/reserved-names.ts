import ts from "typescript";
import type { DependencyPolicy, ReservedName } from "./dependency-policy.ts";
import { referenceSymbol, type ReferenceContext } from "./effects.ts";
import { takenMembers } from "./member-uses.ts";
import {
  reservedUses,
  type ReservedOwner,
  type ReservedOwners,
} from "./reserved-uses.ts";

export interface ReservedNameFinding {
  readonly rule: "reserved-name";
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

export function inspectReservedNames(
  program: ts.Program,
  scope: {
    readonly files: readonly string[];
    readonly policy: DependencyPolicy;
  },
): ReservedNameFinding[] {
  const { files, policy } = scope;
  const reserved = policy.reserved;
  if (!reserved) return [];
  const checker = program.getTypeChecker();
  const owners: ReservedOwners = new Map(
    reserved.names.flatMap((entry) => entryOwners(program, { entry, files })),
  );
  return reservedUses(program, {
    files,
    roles: policy.roles,
    exempt: reserved.exempt,
    owners,
    taken: (node, parent) =>
      referenced(node, { parent, checker }).map((symbol) =>
        target(symbol, checker),
      ),
  }).map((use) => ({
    rule: "reserved-name",
    file: use.file,
    line: use.line,
    name: use.label,
  }));
}

function entryOwners(
  program: ts.Program,
  context: {
    readonly entry: ReservedName;
    readonly files: readonly string[];
  },
): [ts.Declaration, ReservedOwner][] {
  const { entry, files } = context;
  const source = program.getSourceFile(entry.file);
  if (!source && !entry.users.some((user) => files.includes(user))) return [];
  const checker = program.getTypeChecker();
  const module = source && checker.getSymbolAtLocation(source);
  const exported =
    module &&
    checker
      .getExportsOfModule(module)
      .find((symbol) => symbol.name === entry.name);
  const declarations =
    (exported && target(exported, checker).declarations) ?? [];
  if (declarations.length === 0)
    throw new Error(`reserved-missing: ${entry.file}#${entry.name}`);
  const owner = { label: entry.name, users: entry.users };
  return declarations.map((declaration): [ts.Declaration, ReservedOwner] => [
    declaration,
    owner,
  ]);
}

function target(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0
    ? symbol
    : checker.getAliasedSymbol(symbol);
}

function referenced(
  node: ts.Node,
  context: ReferenceContext,
): readonly ts.Symbol[] {
  const { parent, checker } = context;
  if (!ts.isIdentifier(node)) return takenMembers(node, checker);
  if (parent && ts.isTypeOnlyImportOrExportDeclaration(parent)) return [];
  const symbol = referenceSymbol(node, context);
  return symbol ? [symbol] : [];
}
