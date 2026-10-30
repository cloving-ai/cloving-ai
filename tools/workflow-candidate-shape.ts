import ts from "typescript";

export function workflowShape(source: ts.SourceFile): boolean {
  const exported = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
  );
  const candidate = exported[0];
  if (
    exported.length !== 1 ||
    !candidate ||
    !ts.isFunctionDeclaration(candidate)
  )
    return false;
  if (!workflowFunction(candidate)) return false;
  const directives: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && node.text === "use workflow")
      directives.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return directives.length === 1;
}

function workflowFunction(candidate: ts.FunctionDeclaration): boolean {
  if (!candidate.name || !candidate.body || candidate.asteriskToken)
    return false;
  const modifiers = ts.getModifiers(candidate) ?? [];
  if (
    !modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ||
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  )
    return false;
  const first = candidate.body.statements[0];
  return first !== undefined && workflowDirective(first);
}

function workflowDirective(node: ts.Statement): boolean {
  return (
    ts.isExpressionStatement(node) &&
    ts.isStringLiteral(node.expression) &&
    node.expression.text === "use workflow"
  );
}

function unwrappedInitializer(node: ts.Expression): ts.Expression | undefined {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    return node.expression;
  return undefined;
}

function passiveCompound(node: ts.Expression): boolean {
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every(
      (element) =>
        ts.isOmittedExpression(element) || passiveInitializer(element),
    );
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        passiveInitializer(property.initializer),
    );
  return false;
}

function passiveInitializer(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (ts.isLiteralExpression(node)) return true;
  if (
    [
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword,
    ].includes(node.kind)
  )
    return true;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node))
    return (
      [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
        node.operator,
      ) && ts.isNumericLiteral(node.operand)
    );
  const inner = unwrappedInitializer(node);
  return inner ? passiveInitializer(inner) : passiveCompound(node);
}

function passiveStatement(
  node: ts.Statement,
  kind: "workflow" | "helper",
): boolean {
  if (ts.isVariableStatement(node))
    return (
      (node.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      node.declarationList.declarations.every(
        (declaration) =>
          (kind === "helper" ||
            (ts.getCombinedModifierFlags(declaration) &
              ts.ModifierFlags.Export) ===
              0) &&
          ts.isIdentifier(declaration.name) &&
          passiveInitializer(declaration.initializer),
      )
    );
  if (ts.isExpressionStatement(node))
    return ts.isStringLiteral(node.expression);
  return (
    ts.isImportDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isEmptyStatement(node)
  );
}

export function passiveCandidateModule(
  source: ts.SourceFile,
  kind: "workflow" | "helper" = "workflow",
): boolean {
  return source.statements.every((node) => passiveStatement(node, kind));
}
