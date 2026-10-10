import ts from "typescript";
import { isBuiltin } from "node:module";
import { resolve } from "node:path";

export interface DependencyEdge {
  readonly from: string;
  readonly target: string;
  readonly specifier: string;
  readonly kind: "type" | "value";
}

export interface DependencyGraph {
  readonly files: readonly string[];
  readonly edges: readonly DependencyEdge[];
}

export function dependencyGraph(program: ts.Program): DependencyGraph {
  const files = program
    .getRootFileNames()
    .map((file) => resolve(file))
    .sort();
  if (files.length === 0) throw new Error("empty-graph-inventory");
  const edges: DependencyEdge[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing-graph-source: ${file}`);
    const visit = (node: ts.Node, parent?: ts.Node): void => {
      rejectLoading(node, { file, parent });
      const reference = moduleReference(node);
      if (reference)
        edges.push({
          from: file,
          specifier: reference.specifier.text,
          kind: reference.kind,
          target: resolveTarget(program, { source, ...reference }),
        });
      ts.forEachChild(node, (child) => {
        visit(child, node);
      });
    };
    visit(source);
  }
  return { files, edges };
}

function rejectLoading(
  node: ts.Node,
  location: { readonly file: string; readonly parent: ts.Node | undefined },
): void {
  const { file, parent } = location;
  if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return;
  if (
    [
      ts.SyntaxKind.ImportType,
      ts.SyntaxKind.ImportEqualsDeclaration,
      ts.SyntaxKind.ImportKeyword,
    ].includes(node.kind) ||
    (ts.isIdentifier(node) &&
      ["require", "createRequire"].includes(node.text)) ||
    (ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "module")
  )
    throw new Error(`unsupported-loading: ${file}`);
}

function moduleReference(
  node: ts.Node,
): { specifier: ts.StringLiteralLike; kind: "type" | "value" } | undefined {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return;
  const specifier = node.moduleSpecifier;
  if (!specifier || !ts.isStringLiteralLike(specifier)) return;
  return { specifier, kind: typeReference(node) ? "type" : "value" };
}

function typeReference(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  return node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

function resolveTarget(
  program: ts.Program,
  reference: {
    readonly source: ts.SourceFile;
    readonly specifier: ts.StringLiteralLike;
    readonly kind: "type" | "value";
  },
): string {
  const { source, specifier, kind } = reference;
  if (isBuiltin(specifier.text))
    return `node:${specifier.text.replace(/^node:/, "")}`;
  const resolution = ts.resolveModuleName(
    specifier.text,
    source.fileName,
    program.getCompilerOptions(),
    ts.sys,
    undefined,
    undefined,
    program.getModeForUsageLocation(source, specifier),
  ).resolvedModule;
  if (!resolution)
    throw new Error(`unresolved-import: ${source.fileName}: ${specifier.text}`);
  const target = resolve(resolution.resolvedFileName);
  if (
    !resolution.isExternalLibraryImport &&
    kind === "value" &&
    /\.d\.[cm]?ts$/.test(target)
  )
    throw new Error(
      `unqualified-runtime-target: ${source.fileName} -> ${target}`,
    );
  if (
    !resolution.isExternalLibraryImport &&
    !target.endsWith(".json") &&
    !program.getRootFileNames().includes(target)
  )
    throw new Error(`unmapped-import: ${target}`);
  return target;
}
