import ts from "typescript";
import type { CandidateEffect } from "../src/workflow-candidate.ts";
import { resolvedSymbol } from "./workflow-candidate-program.ts";
import { referenceSymbol } from "./workflow-source-effects.ts";
import {
  invalidFields,
  literalField,
  propertyInitializer,
  propertyName,
} from "./workflow-candidate-fields.ts";

export interface CandidateSymbols {
  readonly checker: ts.TypeChecker;
  readonly source: ts.SourceFile;
  readonly protectedSymbol: ts.Symbol | undefined;
  readonly handoffSymbol: ts.Symbol | undefined;
  readonly commandWaitSymbol?: ts.Symbol | undefined;
  readonly commandSymbol: ts.Symbol | undefined;
  readonly reviewSymbol: ts.Symbol | undefined;
  readonly mergeSymbols: readonly ts.Symbol[];
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
      symbols.commandWaitSymbol,
      symbols.reviewSymbol,
      ...symbols.mergeSymbols,
    ].includes(symbol)
  );
}

function calledSymbol(node: ts.CallExpression, symbols: CandidateSymbols) {
  return resolvedSymbol(
    symbols.checker,
    symbols.checker.getSymbolAtLocation(node.expression),
  );
}

export function handoffCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  const symbol = symbols.handoffSymbol;
  return symbol !== undefined && calledSymbol(node, symbols) === symbol;
}

export function commandCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  const symbol = symbols.commandSymbol;
  return symbol !== undefined && calledSymbol(node, symbols) === symbol;
}

export function commandWaitCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  const symbol = symbols.commandWaitSymbol;
  return symbol !== undefined && calledSymbol(node, symbols) === symbol;
}

export function reviewCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  const symbol = symbols.reviewSymbol;
  return symbol !== undefined && calledSymbol(node, symbols) === symbol;
}

export function helperCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  return [handoffCall, commandCall, reviewCall, mergeCall].some((call) =>
    call(node, symbols),
  );
}

export function mergeCall(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  const symbol = calledSymbol(node, symbols);
  return symbol !== undefined && symbols.mergeSymbols.includes(symbol);
}

export function protectedEffectFact(
  node: ts.Node,
  symbols: CandidateSymbols,
): CandidateEffect | undefined {
  if (!protectedCall(node, symbols)) return undefined;
  if (handoffCall(node, symbols) || commandWaitCall(node, symbols))
    return undefined;
  const argument = node.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(argument)) return undefined;
  if (reviewCall(node, symbols))
    return reviewEffectFact(propertyInitializer(argument, "reviewer"));
  if (mergeCall(node, symbols))
    return { capability: "github", method: "merge" };
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
      symbols.commandWaitSymbol,
      symbols.reviewSymbol,
      ...symbols.mergeSymbols,
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
  const reviewer = reviewCall(node, symbols)
    ? propertyInitializer(argument, "reviewer")
    : undefined;
  return (
    invalidFields(argument) ||
    invalidCommandWaitFields(node, symbols) ||
    invalidReviewer(reviewer)
  );
}

function invalidReviewer(reviewer: ts.Node | undefined): boolean {
  return (
    reviewer !== undefined &&
    ts.isObjectLiteralExpression(reviewer) &&
    invalidFields(reviewer)
  );
}

function invalidCommandWaitFields(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  if (!commandWaitCall(node, symbols)) return false;
  const argument = node.arguments[0];
  return (
    !!argument &&
    ts.isObjectLiteralExpression(argument) &&
    argument.properties.some(
      (entry) =>
        entry.name &&
        !["name", "input"].includes(propertyName(entry.name) ?? ""),
    )
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
