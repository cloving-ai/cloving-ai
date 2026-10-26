import ts from "typescript";
import {
  candidateEffectTotals,
  candidateLoopRepetitions,
  type Totals,
} from "./workflow-candidate-counts.ts";
import {
  protectedCall,
  type CandidateSymbols,
} from "./workflow-candidate-syntax.ts";
import { resolvedSymbol } from "./workflow-candidate-program.ts";
import { referenceSymbol } from "./workflow-source-effects.ts";

const zero: Totals = { knownCallCount: 0, knownUnitTotal: 0 };

export function helperEffectTotals(input: {
  readonly symbols: CandidateSymbols;
  readonly sources: readonly ts.SourceFile[];
}): Totals & { readonly unsupportedForms: readonly string[] } {
  const { symbols, sources } = input;
  const unsupportedForms: string[] = [];
  if (sources.length === 1) return { ...zero, unsupportedForms };
  const active = new Set<ts.FunctionDeclaration>();
  const totals = new Map<ts.FunctionDeclaration, Totals>();
  const functions = localFunctions(sources);
  const functionAt = (node: ts.Identifier) =>
    localFunctionAt(node, { checker: symbols.checker, functions });
  function count(declaration: ts.FunctionDeclaration): Totals {
    const cached = totals.get(declaration);
    if (cached) return cached;
    if (active.has(declaration)) {
      unsupportedForms.push("recursive-helper-effects");
      return zero;
    }
    active.add(declaration);
    const result = candidateEffectTotals(declaration, {
      ...symbols,
      localTotals: (node) => {
        if (ts.isFunctionLike(node) && node !== declaration) return zero;
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
          return undefined;
        const called = functionAt(node.expression);
        return called && effectful.has(called) ? count(called) : undefined;
      },
    });
    active.delete(declaration);
    totals.set(declaration, result);
    return result;
  }
  const effectful = effectfulFunctions({ functions, functionAt, symbols });
  if ([...effectful].every((entry) => entry.getSourceFile() === symbols.source))
    return { ...zero, unsupportedForms };
  for (const source of sources)
    inspectHelperReferences(source, {
      functionAt,
      effectful,
      symbols,
      unsupportedForms,
    });
  for (const declaration of effectful) count(declaration);
  const workflow = [...functions].find(
    (entry) =>
      entry.getSourceFile() === symbols.source &&
      (ts.getCombinedModifierFlags(entry) & ts.ModifierFlags.Export) !== 0,
  );
  return { ...(workflow ? count(workflow) : zero), unsupportedForms };
}

function localFunctions(sources: readonly ts.SourceFile[]) {
  return new Set(
    sources.flatMap((source) =>
      source.statements.filter(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.body !== undefined,
      ),
    ),
  );
}

function localFunctionAt(
  node: ts.Identifier,
  input: {
    readonly checker: ts.TypeChecker;
    readonly functions: ReadonlySet<ts.FunctionDeclaration>;
  },
): ts.FunctionDeclaration | undefined {
  const symbol = resolvedSymbol(
    input.checker,
    referenceSymbol(node, {
      parent: node.parent,
      checker: input.checker,
    }),
  );
  return symbol?.declarations?.find(
    (entry): entry is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(entry) && input.functions.has(entry),
  );
}

interface HelperReferences {
  readonly functionAt: (
    node: ts.Identifier,
  ) => ts.FunctionDeclaration | undefined;
  readonly symbols: CandidateSymbols;
}

function effectfulFunctions(
  input: HelperReferences & {
    readonly functions: ReadonlySet<ts.FunctionDeclaration>;
  },
): ReadonlySet<ts.FunctionDeclaration> {
  const effectful = new Set<ts.FunctionDeclaration>();
  const calls = (node: ts.Node): boolean => {
    if (protectedCall(node, input.symbols)) return true;
    if (ts.isIdentifier(node)) {
      const called = input.functionAt(node);
      if (called && effectful.has(called)) return true;
    }
    return ts.forEachChild(node, (child) => calls(child) || undefined) ?? false;
  };
  let previous = -1;
  while (previous !== effectful.size) {
    previous = effectful.size;
    for (const declaration of input.functions)
      if (calls(declaration)) effectful.add(declaration);
  }
  return effectful;
}

function inspectHelperReferences(
  source: ts.SourceFile,
  input: HelperReferences & {
    readonly effectful: ReadonlySet<ts.FunctionDeclaration>;
    readonly unsupportedForms: string[];
  },
): void {
  function visit(node: ts.Node): void {
    if (
      source !== input.symbols.source &&
      protectedCall(node, input.symbols) &&
      !checkedHelperContext(node, input.symbols)
    )
      input.unsupportedForms.push("uncheckable-helper-effects");
    if (ts.isIdentifier(node)) {
      const declaration = input.functionAt(node);
      if (
        declaration &&
        input.effectful.has(declaration) &&
        !checkedHelperReference(node, input.symbols)
      )
        input.unsupportedForms.push("uncheckable-helper-effects");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function checkedHelperReference(
  node: ts.Identifier,
  symbols: CandidateSymbols,
): boolean {
  if (ts.isFunctionDeclaration(node.parent) && node.parent.name === node)
    return true;
  if (ts.isImportSpecifier(node.parent)) return true;
  if (
    !ts.isCallExpression(node.parent) ||
    node.parent.expression !== node ||
    node.parent.questionDotToken !== undefined
  )
    return false;
  return checkedHelperContext(node.parent, symbols);
}

function checkedHelperContext(
  node: ts.CallExpression,
  symbols: CandidateSymbols,
): boolean {
  let parent: ts.Node = node;
  while (!ts.isFunctionLike(parent)) {
    if (ts.isSourceFile(parent)) return false;
    if (
      ts.isIterationStatement(parent, false) &&
      candidateLoopRepetitions(parent, symbols) === undefined
    )
      return false;
    parent = parent.parent;
  }
  return ts.isFunctionDeclaration(parent) && ts.isSourceFile(parent.parent);
}
