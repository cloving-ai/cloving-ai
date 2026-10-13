import ts from "typescript";

export function takenMembers(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Symbol[] {
  if (ts.isPropertyAccessExpression(node))
    return named(checker, {
      type: checker.getTypeAtLocation(node.expression),
      names: [node.name.text],
    });
  if (ts.isElementAccessExpression(node))
    return named(checker, {
      type: checker.getTypeAtLocation(node.expression),
      names: literalNames(checker.getTypeAtLocation(node.argumentExpression)),
    });
  if (ts.isSpreadAssignment(node))
    return members(checker, checker.getTypeAtLocation(node.expression));
  if (ts.isObjectBindingPattern(node))
    return node.elements.flatMap((element) =>
      named(checker, {
        type: checker.getTypeAtLocation(node),
        names: element.dotDotDotToken
          ? undefined
          : keyNames(checker, element.propertyName ?? element.name),
      }),
    );
  if (ts.isObjectLiteralExpression(node) && assignmentTarget(node))
    return node.properties.flatMap((property) =>
      named(checker, {
        type: checker.getTypeOfAssignmentPattern(node),
        names: targetNames(checker, property),
      }),
    );
  return [];
}

function members(checker: ts.TypeChecker, type: ts.Type): ts.Symbol[] {
  const parts = type.isUnion() ? type.types : [type];
  return parts.flatMap((part) => checker.getPropertiesOfType(part));
}

function named(
  checker: ts.TypeChecker,
  taken: {
    readonly type: ts.Type;
    readonly names: readonly string[] | undefined;
  },
): ts.Symbol[] {
  const { type, names } = taken;
  if (!names) return members(checker, type);
  return members(checker, type).filter((member) => names.includes(member.name));
}

function literalNames(type: ts.Type): readonly string[] | undefined {
  const parts = type.isUnion() ? type.types : [type];
  const names = parts.flatMap((part) =>
    part.isStringLiteral() || part.isNumberLiteral()
      ? [String(part.value)]
      : [],
  );
  return names.length === parts.length ? names : undefined;
}

function keyNames(
  checker: ts.TypeChecker,
  key: ts.PropertyName | ts.BindingName,
): readonly string[] | undefined {
  if (ts.isComputedPropertyName(key))
    return literalNames(checker.getTypeAtLocation(key.expression));
  if (ts.isObjectBindingPattern(key) || ts.isArrayBindingPattern(key))
    return [];
  return [key.text];
}

function targetNames(
  checker: ts.TypeChecker,
  property: ts.ObjectLiteralElementLike,
): readonly string[] | undefined {
  if (ts.isSpreadAssignment(property)) return undefined;
  if (ts.isShorthandPropertyAssignment(property)) return [property.name.text];
  if (ts.isPropertyAssignment(property))
    return keyNames(checker, property.name);
  return [];
}

function assignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent))
    return (
      parent.left === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    );
  if (ts.isForOfStatement(parent)) return parent.initializer === node;
  if (ts.isPropertyAssignment(parent))
    return parent.initializer === node && assignmentTarget(parent.parent);
  if (ts.isArrayLiteralExpression(parent)) return assignmentTarget(parent);
  return false;
}
