import ts from "typescript";
import type { CandidateEffect } from "../src/workflow-candidate.ts";
import { resolvedSymbol } from "./workflow-candidate-program.ts";
import { referenceSymbol } from "./workflow-source-effects.ts";

export interface CandidateSymbols {
  readonly checker: ts.TypeChecker;
  readonly source: ts.SourceFile;
  readonly protectedSymbol: ts.Symbol | undefined;
  readonly handoffSymbol: ts.Symbol | undefined;
  readonly commandSymbol: ts.Symbol | undefined;
  readonly reviewSymbol: ts.Symbol | undefined;
}

export function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

export function protectedCall(
  node: ts.Node,
  symbols: CandidateSymbols,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
    return false;
  const symbol = resolvedSymbol(
    symbols.checker,
    symbols.checker.getSymbolAtLocation(node.expression),
  );
  return (
    symbol !== undefined &&
    [
      symbols.protectedSymbol,
      symbols.handoffSymbol,
      symbols.commandSymbol,
      symbols.reviewSymbol,
    ].includes(symbol)
  );
}

export function handoffCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  return (
    symbols.handoffSymbol !== undefined &&
    resolvedSymbol(
      symbols.checker,
      symbols.checker.getSymbolAtLocation(node.expression),
    ) === symbols.handoffSymbol
  );
}

export function commandCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  return (
    symbols.commandSymbol !== undefined &&
    resolvedSymbol(
      symbols.checker,
      symbols.checker.getSymbolAtLocation(node.expression),
    ) === symbols.commandSymbol
  );
}

export function reviewCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  return (
    symbols.reviewSymbol !== undefined &&
    resolvedSymbol(
      symbols.checker,
      symbols.checker.getSymbolAtLocation(node.expression),
    ) === symbols.reviewSymbol
  );
}

function propertyInitializer(node: ts.Node | undefined, field: string) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find(
    (entry) => entry.name && propertyName(entry.name) === field,
  );
  return property && ts.isPropertyAssignment(property)
    ? property.initializer
    : undefined;
}

function literalField(node: ts.Node | undefined, field: string) {
  const value = propertyInitializer(node, field);
  return value && ts.isStringLiteral(value) ? value.text : null;
}

export function protectedEffectFact(
  node: ts.Node,
  symbols: CandidateSymbols,
): CandidateEffect | undefined {
  if (!protectedCall(node, symbols)) return undefined;
  if (handoffCall(node, symbols)) return undefined;
  const argument = node.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
  if (reviewCall(node, symbols))
    return reviewEffectFact(propertyInitializer(argument, "reviewer"));
  if (commandCall(node, symbols)) {
    const name = literalField(argument, "name");
    return {
      capability: "command",
      method: name === null ? null : `run:${name}`,
    };
  }
  return {
    capability: literalField(argument, "capability"),
    method: literalField(argument, "method"),
  };
}

function reviewEffectFact(reviewer: ts.Node | undefined): CandidateEffect {
  const kind = literalField(reviewer, "kind");
  if (kind === "greptile")
    return { capability: "github", method: "wait-review" };
  const profile = literalField(reviewer, "profile");
  if (
    kind === "turn" &&
    profile !== null &&
    /^[A-Za-z0-9_-]{1,119}$/.test(profile)
  )
    return { capability: "claude", method: `run-turn:${profile}` };
  return { capability: null, method: null };
}

function escapedHelper(node: ts.Node, symbols: CandidateSymbols): boolean {
  if (!ts.isIdentifier(node)) return false;
  const symbol = resolvedSymbol(
    symbols.checker,
    referenceSymbol(node, { parent: node.parent, checker: symbols.checker }),
  );
  if (
    symbol === undefined ||
    ![
      symbols.protectedSymbol,
      symbols.handoffSymbol,
      symbols.commandSymbol,
      symbols.reviewSymbol,
    ].includes(symbol)
  )
    return false;
  if (ts.isImportSpecifier(node.parent)) return false;
  return (
    !ts.isCallExpression(node.parent) ||
    node.parent.expression !== node ||
    node.parent.questionDotToken !== undefined
  );
}

function invalidImport(node: ts.Node): boolean {
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  return (
    !clause ||
    clause.name !== undefined ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings) ||
    node.attributes !== undefined
  );
}

function invalidRequest(node: ts.Node, symbols: CandidateSymbols): boolean {
  if (!protectedCall(node, symbols)) return false;
  if (!workflowBodyCall(node)) return true;
  const argument = node.arguments[0];
  if (
    node.arguments.length !== 1 ||
    !argument ||
    !ts.isObjectLiteralExpression(argument)
  )
    return true;
  const names = argument.properties.map(
    (entry) => entry.name && propertyName(entry.name),
  );
  return (
    names.includes(undefined) ||
    new Set(names).size !== names.length ||
    argument.properties.some((entry) => !ts.isPropertyAssignment(entry))
  );
}

function workflowBodyCall(node: ts.Node): boolean {
  let child = node;
  let parent = node.parent;
  while (!ts.isFunctionLike(parent)) {
    if (ts.isSourceFile(parent) || ts.isClassLike(parent)) return false;
    child = parent;
    parent = parent.parent;
  }
  if (!ts.isFunctionDeclaration(parent) || !ts.isSourceFile(parent.parent))
    return false;
  return (
    parent.body === child &&
    (ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Export) !== 0
  );
}

function dynamicLoading(node: ts.Node, symbols: CandidateSymbols): boolean {
  if (
    node.kind === ts.SyntaxKind.ImportKeyword ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isImportTypeNode(node) ||
    ts.isMetaProperty(node)
  )
    return true;
  if (!ts.isIdentifier(node) || node.text !== "require") return false;
  const symbol = symbols.checker.getSymbolAtLocation(node);
  return !symbol?.declarations?.some(
    (entry) => entry.getSourceFile() === symbols.source,
  );
}

function ambientDeclaration(node: ts.Node): boolean {
  if (ts.isModuleDeclaration(node)) return true;
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    )
  );
}

function computedAccess(node: ts.Node): boolean {
  if (ts.isComputedPropertyName(node)) return true;
  return (
    ts.isElementAccessExpression(node) &&
    !ts.isStringLiteral(node.argumentExpression) &&
    !ts.isNumericLiteral(node.argumentExpression)
  );
}

export function unsupportedCandidateNode(
  node: ts.Node,
  symbols: CandidateSymbols,
): boolean {
  const checks = [
    escapedHelper(node, symbols),
    invalidImport(node),
    invalidRequest(node, symbols),
    dynamicLoading(node, symbols),
    ambientDeclaration(node),
    computedAccess(node),
    ts.isExportDeclaration(node) || ts.isExportAssignment(node),
    ts.isSpreadAssignment(node) || ts.isSpreadElement(node),
    node.kind === ts.SyntaxKind.ThisKeyword || ts.isWithStatement(node),
    ts.isStringLiteral(node) && node.text === "use step",
  ];
  return checks.some(Boolean);
}

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
