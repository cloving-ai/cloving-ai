import ts from "typescript";
import { referencedSymbol } from "./referenced-symbol.ts";

function valueReference(node: ts.Node, parent: ts.Node | undefined): boolean {
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return true;
  if (!ts.isIdentifier(node)) return false;
  return ![
    ts.isImportSpecifier,
    ts.isImportClause,
    ts.isNamespaceImport,
    ts.isExportSpecifier,
    ts.isPropertyAccessExpression,
    ts.isElementAccessExpression,
  ].some((predicate) => predicate(parent));
}

function protectedCallable(type: ts.Type): boolean {
  return type.getCallSignatures().some((signature) => {
    const file = signature.declaration?.getSourceFile().fileName;
    return (
      !!file &&
      /\/@types\/node\/(?:assert(?:\/strict)?|test)\.d\.ts$/.test(file)
    );
  });
}

export function escapedTestApi(
  node: ts.Node,
  ancestors: readonly ts.Node[],
  checker: ts.TypeChecker,
): boolean {
  const parent = ancestors.at(-1);
  if (!valueReference(node, parent) || ancestors.some(ts.isTypeNode))
    return false;
  if (parent && ts.isCallExpression(parent) && parent.expression === node)
    return false;
  const symbol = referencedSymbol(node, parent, checker);
  const type = symbol
    ? checker.getTypeOfSymbolAtLocation(symbol, node)
    : checker.getTypeAtLocation(node);
  return (
    protectedCallable(type) ||
    type
      .getProperties()
      .some((property) =>
        protectedCallable(checker.getTypeOfSymbolAtLocation(property, node)),
      )
  );
}
