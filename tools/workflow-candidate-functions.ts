import ts from "typescript";
import type {
  CandidateEffect,
  CandidateFunctionAnalysis,
} from "../src/workflow-candidate.ts";
import { workflowFunction } from "./workflow-candidate-shape.ts";
import { helperEffectTotals } from "./workflow-candidate-helper-counts.ts";
import { resolvedSymbol } from "./workflow-candidate-program.ts";
import {
  protectedEffectFact,
  type CandidateSymbols,
} from "./workflow-candidate-syntax.ts";

export function candidateFunctions(input: {
  readonly symbols: CandidateSymbols;
  readonly sources: readonly ts.SourceFile[];
  readonly modules: ReadonlyMap<string, ts.SourceFile>;
}): Readonly<Record<string, CandidateFunctionAnalysis>> {
  const helpers = helperSymbols(input);
  return Object.fromEntries(
    input.symbols.source.statements
      .filter(ts.isFunctionDeclaration)
      .filter(workflowFunction)
      .filter(
        (node) =>
          (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0,
      )
      .flatMap((root) => {
        const counted = helperEffectTotals({ ...input, root });
        return [
          [
            root.name.text,
            {
              effects: reachableEffects(root, { ...input, helpers }),
              knownCallCount: counted.totals.knownCallCount,
              knownUnitTotal: counted.totals.knownUnitTotal,
              unsupportedForms: counted.unsupportedForms,
            },
          ],
        ];
      }),
  );
}

function helperSymbols(input: {
  readonly symbols: CandidateSymbols;
  readonly modules: ReadonlyMap<string, ts.SourceFile>;
}): ReadonlyMap<ts.Symbol, string> {
  const { checker } = input.symbols;
  const helpers = new Map<ts.Symbol, string>();
  for (const source of input.modules.values()) {
    const module = checker.getSymbolAtLocation(source);
    if (module === undefined) continue;
    for (const entry of checker.getExportsOfModule(module)) {
      const symbol = resolvedSymbol(checker, entry);
      if (symbol !== undefined) helpers.set(symbol, entry.name);
    }
  }
  return helpers;
}

function reachableEffects(
  root: ts.FunctionDeclaration,
  input: {
    readonly symbols: CandidateSymbols;
    readonly sources: readonly ts.SourceFile[];
    readonly helpers: ReadonlyMap<ts.Symbol, string>;
  },
): readonly CandidateEffect[] {
  const visited = new Set<ts.Node>();
  const effects: CandidateEffect[] = [];
  function visit(node: ts.Node): void {
    if (visited.has(node)) return;
    visited.add(node);
    const effect = protectedEffectFact(node, input.symbols);
    if (effect !== undefined) effects.push(effect);
    if (ts.isCallExpression(node))
      calledFunction(node, { ...input, effects, visit });
    ts.forEachChild(node, visit);
  }
  visit(root);
  return effects;
}

function calledFunction(
  node: ts.CallExpression,
  input: {
    readonly symbols: CandidateSymbols;
    readonly sources: readonly ts.SourceFile[];
    readonly helpers: ReadonlyMap<ts.Symbol, string>;
    readonly effects: CandidateEffect[];
    readonly visit: (node: ts.Node) => void;
  },
): void {
  const { checker } = input.symbols;
  const symbol = resolvedSymbol(
    checker,
    checker.getSymbolAtLocation(node.expression),
  );
  if (symbol === undefined) return;
  const helper = input.helpers.get(symbol);
  if (
    helper !== undefined &&
    !["protectedEffect", "runCommand", "loadCycle", "ticketStatus"].includes(
      helper,
    )
  )
    input.effects.push({ capability: "workflow", method: helper });
  for (const declaration of symbol.declarations ?? [])
    if (
      input.sources.includes(declaration.getSourceFile()) &&
      ts.isFunctionDeclaration(declaration)
    )
      input.visit(declaration);
}
