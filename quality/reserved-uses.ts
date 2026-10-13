import type ts from "typescript";
import { visitValueNodes } from "./value-nodes.ts";

export interface ReservedOwner {
  readonly label: string;
  readonly users: readonly string[];
}

export type ReservedOwners = ReadonlyMap<ts.Declaration, ReservedOwner>;

export interface ReservedUse {
  readonly file: string;
  readonly line: number;
  readonly label: string;
}

type Taken = (
  node: ts.Node,
  parent: ts.Node | undefined,
) => readonly ts.Symbol[];

export interface UseInspection {
  readonly files: readonly string[];
  readonly roles: Readonly<Record<string, string>>;
  readonly exempt: readonly string[];
  readonly owners: ReservedOwners;
  readonly taken: Taken;
}

export function reservedUses(
  program: ts.Program,
  inspection: UseInspection,
): ReservedUse[] {
  const { files, roles, exempt, owners, taken } = inspection;
  if (owners.size === 0) return [];
  return files
    .filter((file) => !exempt.includes(roles[file] ?? ""))
    .flatMap((file) => fileUses(program, { file, owners, taken }));
}

function fileUses(
  program: ts.Program,
  inspection: {
    readonly file: string;
    readonly owners: ReservedOwners;
    readonly taken: Taken;
  },
): ReservedUse[] {
  const { file, owners, taken } = inspection;
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`missing-reserved-source: ${file}`);
  if (source.isDeclarationFile) return [];
  const uses: ReservedUse[] = [];
  visitValueNodes(source, (node, parent) => {
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const owned = new Set(
      taken(node, parent)
        .flatMap((symbol) => symbol.declarations ?? [])
        .flatMap((declaration) => owners.get(declaration) ?? []),
    );
    uses.push(
      ...[...owned]
        .filter((owner) => !owner.users.includes(file))
        .map((owner) => ({ file, line, label: owner.label })),
    );
  });
  return uses;
}
