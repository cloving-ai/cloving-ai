import ts from "typescript";

export function referencedSymbol(
  node: ts.Node,
  parent: ts.Node | undefined,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const symbol =
    parent && ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    return checker.getAliasedSymbol(symbol);
  return symbol;
}
