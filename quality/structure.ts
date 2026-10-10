import ts from "typescript";

export interface StructureFinding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly measured: number | "unbounded";
  readonly limit: number;
}

function isTuple(
  checker: ts.TypeChecker,
  type: ts.Type,
): type is ts.TupleTypeReference {
  return checker.isTupleType(type);
}

function finding(
  node: ts.Node,
  violation: {
    readonly rule: string;
    readonly measured: number | "unbounded";
    readonly limit: number;
  },
): StructureFinding {
  const { rule, measured, limit } = violation;
  const source = node.getSourceFile();
  return {
    rule,
    measured,
    limit,
    file: source.fileName,
    line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  };
}

function parameterFinding(
  node: ts.Node,
  checker: ts.TypeChecker,
): StructureFinding | undefined {
  if (!ts.isParameter(node)) return;
  const declared = checker.getTypeAtLocation(node);
  const constrained = checker.getBaseConstraintOfType(declared) ?? declared;
  const type = node.dotDotDotToken
    ? checker.getIndexTypeOfType(constrained, ts.IndexKind.Number)
    : constrained;
  if (!type) return;
  if (containsBoolean(type, checker)) {
    return finding(node, {
      rule: "no-boolean-parameter",
      measured: 1,
      limit: 0,
    });
  }
  return undefined;
}

function containsBoolean(declared: ts.Type, checker: ts.TypeChecker): boolean {
  const type = checker.getBaseConstraintOfType(declared) ?? declared;
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return true;
  if (!type.isUnionOrIntersection()) return false;
  return type.types.some((member) => containsBoolean(member, checker));
}

type Positions = number | "unbounded";

function largest(counts: readonly Positions[]): Positions {
  if (counts.includes("unbounded")) return "unbounded";
  return Math.max(...counts.map(Number));
}

function tupleCount(
  type: ts.TupleTypeReference,
  checker: ts.TypeChecker,
): Positions {
  const variadic = (type.target.combinedFlags & ts.ElementFlags.Variadic) !== 0;
  return variadic ? "unbounded" : checker.getTypeArguments(type).length;
}

function constraintCount(
  type: ts.TypeParameter,
  checker: ts.TypeChecker,
): Positions {
  const declaration = type.symbol.declarations?.find(
    ts.isTypeParameterDeclaration,
  );
  if (!declaration?.constraint || ts.isInferTypeNode(declaration.parent))
    return "unbounded";
  return declaredCount(
    checker.getTypeFromTypeNode(declaration.constraint),
    checker,
  );
}

function declaredCount(type: ts.Type, checker: ts.TypeChecker): Positions {
  if (type.isUnion())
    return largest(type.types.map((member) => declaredCount(member, checker)));
  if (type.isTypeParameter()) return constraintCount(type, checker);
  if (isTuple(checker, type)) return tupleCount(type, checker);
  return checker.isArrayType(type) ? 1 : "unbounded";
}

function boundNames(name: ts.BindingName): number {
  if (ts.isIdentifier(name)) return 1;
  return name.elements.reduce<number>(
    (total, element) =>
      total + (ts.isBindingElement(element) ? boundNames(element.name) : 1),
    0,
  );
}

function inferPatternCount(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): Positions | undefined {
  const { type } = parameter;
  if (!type || !ts.isInferTypeNode(type)) return undefined;
  const { constraint } = type.typeParameter;
  if (!constraint) return 1;
  return declaredCount(checker.getTypeFromTypeNode(constraint), checker);
}

function restPositions(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): Positions {
  const count =
    inferPatternCount(parameter, checker) ??
    declaredCount(checker.getTypeAtLocation(parameter), checker);
  if (count === "unbounded") return "unbounded";
  const named = ts.isIdentifier(parameter.name)
    ? 0
    : boundNames(parameter.name);
  return Math.max(named, count);
}

function positions(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): Positions {
  if (ts.isIdentifier(parameter.name) && parameter.name.text === "this")
    return 0;
  return parameter.dotDotDotToken ? restPositions(parameter, checker) : 1;
}

function positionalFinding(
  node: ts.Node,
  checker: ts.TypeChecker,
): StructureFinding | undefined {
  if (!ts.isFunctionLike(node)) return;
  const counts = node.parameters.map((parameter) =>
    positions(parameter, checker),
  );
  const measured = counts.includes("unbounded")
    ? "unbounded"
    : counts.reduce<number>((total, count) => total + Number(count), 0);
  if (measured === "unbounded" || measured > 2)
    return finding(node, {
      rule: "max-positional-parameters",
      measured,
      limit: 2,
    });
  return undefined;
}

function returnFinding(
  node: ts.Node,
  checker: ts.TypeChecker,
): StructureFinding | undefined {
  if (!ts.isFunctionLike(node)) return;
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) return;
  const declared = checker.getReturnTypeOfSignature(signature);
  const result = checker.getAwaitedType(
    checker.getBaseConstraintOfType(declared) ?? declared,
  );
  if (!result) return;
  const alternatives = result.isUnion() ? result.types : [result];
  const unbounded = alternatives.some(
    (type) =>
      isTuple(checker, type) &&
      (type.target.combinedFlags & ts.ElementFlags.Variable) !== 0,
  );
  if (unbounded)
    return finding(node, {
      rule: "max-tuple-results",
      measured: "unbounded",
      limit: 3,
    });
  const count = Math.max(
    0,
    ...alternatives.map((type) =>
      isTuple(checker, type) ? checker.getTypeArguments(type).length : 0,
    ),
  );
  if (count > 3)
    return finding(node, {
      rule: "max-tuple-results",
      measured: count,
      limit: 3,
    });
  return undefined;
}

function typeMembers(
  node: ts.Node,
  context: { readonly symbol: ts.Symbol; readonly checker: ts.TypeChecker },
): ts.Symbol[] {
  const { symbol, checker } = context;
  const declared = checker.getDeclaredTypeOfSymbol(symbol);
  if (
    ts.isTypeAliasDeclaration(node) &&
    (checker.isTupleType(declared) ||
      checker.isArrayType(declared) ||
      (declared.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) ===
        0)
  )
    return [];
  const members = new Set(checker.getPropertiesOfType(declared));
  if (ts.isClassLike(node)) {
    for (const member of checker.getPropertiesOfType(
      checker.getTypeOfSymbolAtLocation(symbol, node),
    ))
      members.add(member);
  }
  return [...members];
}

function memberFinding(
  node: ts.Node,
  inspection: {
    readonly checker: ts.TypeChecker;
    readonly seen: Set<ts.Symbol>;
  },
): StructureFinding | undefined {
  const { checker, seen } = inspection;
  if (
    !ts.isInterfaceDeclaration(node) &&
    !ts.isClassLike(node) &&
    !ts.isTypeAliasDeclaration(node)
  )
    return;
  const symbol = declarationSymbol(node, checker);
  if (!symbol || seen.has(symbol)) return;
  seen.add(symbol);
  const representative = symbol.declarations?.find(ts.isClassLike) ?? node;
  const callable = typeMembers(representative, { symbol, checker }).filter(
    (member) => {
      const type = checker.getNonNullableType(
        checker.getTypeOfSymbolAtLocation(member, node),
      );
      return (
        checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
      );
    },
  );
  const policy = ts.isInterfaceDeclaration(representative)
    ? { rule: "max-interface-callables", limit: 10 }
    : { rule: "max-type-callables", limit: 24 };
  if (callable.length > policy.limit)
    return finding(node, { ...policy, measured: callable.length });
  return undefined;
}

function declarationSymbol(
  node:
    ts.InterfaceDeclaration | ts.ClassLikeDeclaration | ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (node.name) return checker.getSymbolAtLocation(node.name);
  return checker.getTypeAtLocation(node).getSymbol();
}

export function inspectStructure(program: ts.Program): StructureFinding[] {
  const checker = program.getTypeChecker();
  const roots = new Set(program.getRootFileNames());
  const findings: StructureFinding[] = [];
  const inspection = { checker, seen: new Set<ts.Symbol>() };
  function visit(node: ts.Node): void {
    const results = [
      parameterFinding(node, checker),
      positionalFinding(node, checker),
      returnFinding(node, checker),
      memberFinding(node, inspection),
    ];
    for (const result of results) {
      if (result) findings.push(result);
    }
    ts.forEachChild(node, visit);
  }
  for (const source of program.getSourceFiles()) {
    if (roots.has(source.fileName)) visit(source);
  }
  return findings;
}
