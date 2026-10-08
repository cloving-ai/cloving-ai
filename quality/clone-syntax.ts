import { extname } from "node:path";
import ts from "typescript";

export function assertCloneSyntax(file: string, source: string): void {
  const extension = extname(file);
  if ([".jsx", ".tsx"].includes(extension))
    throw new Error(`JSX clone analysis is unqualified: ${file}`);
  if (![".js", ".mjs", ".cjs"].includes(extension)) return;
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  function visit(node: ts.Node): void {
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    )
      throw new Error(`JSX clone analysis is unqualified: ${file}`);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}
