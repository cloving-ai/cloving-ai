import ts from "typescript";

export function visitValueNodes(
  source: ts.SourceFile,
  inspect: (node: ts.Node, parent: ts.Node | undefined) => void,
): void {
  const visit = (node: ts.Node, parent?: ts.Node): void => {
    if (typeOnly(node)) return;
    inspect(node, parent);
    ts.forEachChild(node, (child) => {
      visit(child, node);
    });
  };
  visit(source);
}

function typeOnly(node: ts.Node): boolean {
  return (
    (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  );
}
