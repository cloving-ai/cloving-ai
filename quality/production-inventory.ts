import type ts from "typescript";

export function productionInventory(
  program: ts.Program,
  mapping: {
    readonly files: readonly string[];
    readonly roles: Readonly<Record<string, string>>;
  },
): string[] {
  const { files, roles } = mapping;
  const production = new Set([
    "cli",
    "workflow",
    "pure",
    "step",
    "broker",
    "storage",
    "harness",
    "service",
    "host-bridge",
  ]);
  const development = new Set(["quality", "test", "build", "configuration"]);
  const result: string[] = [];
  for (const file of files) {
    const role = roles[file];
    if (!role) throw new Error(`unmapped-coverage-source: ${file}`);
    if (development.has(role)) continue;
    if (!production.has(role))
      throw new Error(`unqualified-coverage-role: ${file}`);
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing-coverage-source: ${file}`);
    if (source.isDeclarationFile)
      throw new Error(`unadmitted-coverage-declaration: ${file}`);
    result.push(file);
  }
  return result.sort();
}
