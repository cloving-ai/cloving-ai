import ts from "typescript";
import {
  candidateProgram,
  resolvedSymbol,
  type CandidatePackageOptions,
} from "./workflow-candidate-program.ts";
import {
  protectedEffectFact,
  passiveCandidateModule,
  unsupportedCandidateNode,
  workflowShape,
  type CandidateSymbols,
} from "./workflow-candidate-syntax.ts";
import { sourceEffectNodes } from "./workflow-source-effects.ts";
import { candidateEffectTotals } from "./workflow-candidate-counts.ts";
import type {
  CandidateAnalysis,
  CandidateEffect,
  CandidateImport,
  InstalledWorkflowExports,
} from "../src/workflow-candidate.ts";

function exportSnapshot(
  modules: ReadonlyMap<string, ts.SourceFile>,
  checker: ts.TypeChecker,
): InstalledWorkflowExports {
  return Object.fromEntries(
    [...modules].map(([name, declaration]) => {
      const symbol = checker.getSymbolAtLocation(declaration);
      return [
        name,
        symbol
          ? checker
              .getExportsOfModule(symbol)
              .map((entry) => entry.name)
              .sort()
          : [],
      ];
    }),
  );
}

function protectedHelper(
  modules: ReadonlyMap<string, ts.SourceFile>,
  options: {
    readonly checker: ts.TypeChecker;
    readonly subpath: string;
    readonly name: string;
  },
): ts.Symbol | undefined {
  const { checker } = options;
  const protectedModule = modules.get(options.subpath);
  const moduleSymbol =
    protectedModule && checker.getSymbolAtLocation(protectedModule);
  return (
    moduleSymbol &&
    resolvedSymbol(
      checker,
      checker
        .getExportsOfModule(moduleSymbol)
        .find((entry) => entry.name === options.name),
    )
  );
}

function sourceFacts(symbols: CandidateSymbols): CandidateAnalysis {
  const { source } = symbols;
  const imports: CandidateImport[] = [];
  const effects: CandidateEffect[] = [];
  const unsupportedForms: string[] = [];
  function visit(node: ts.Node): void {
    const imported = sourceImport(node);
    if (imported) imports.push(imported);
    const effect = protectedEffectFact(node, symbols);
    if (effect) effects.push(effect);
    if (unsupportedCandidateNode(node, symbols))
      unsupportedForms.push("unsupported-syntax");
    ts.forEachChild(node, visit);
  }
  visit(source);
  return {
    imports,
    effects,
    directEffects: sourceEffectNodes(source, {
      checker: symbols.checker,
      profile: "candidate",
    })
      .filter((node) => !ts.isIdentifier(node) || node.text !== "require")
      .map(() => "restricted-effect"),
    unsupportedForms,
    ...candidateEffectTotals(source, symbols),
  };
}

function sourceImport(node: ts.Node): CandidateImport | undefined {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier)
  )
    return undefined;
  const bindings = node.importClause?.namedBindings;
  return {
    module: node.moduleSpecifier.text,
    names:
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map(
            (entry) => entry.propertyName?.text ?? entry.name.text,
          )
        : [],
  };
}

export function analyzeWorkflowCandidate(
  text: string,
  installed: CandidatePackageOptions = {},
): {
  readonly analysis: CandidateAnalysis;
  readonly installedExports: InstalledWorkflowExports;
} {
  const { program, source, modules } = candidateProgram(text, installed);
  const checker = program.getTypeChecker();
  const symbols = {
    checker,
    source,
    protectedSymbol: protectedHelper(modules, {
      checker,
      subpath: "cloving/workflows/steps/protected-effect",
      name: "protectedEffect",
    }),
    handoffSymbol: protectedHelper(modules, {
      checker,
      subpath: "cloving/workflows/steps/handoff",
      name: "handoff",
    }),
  };
  const facts = sourceFacts(symbols);
  const invalid =
    !workflowShape(source) ||
    source.referencedFiles.length > 0 ||
    source.typeReferenceDirectives.length > 0 ||
    source.libReferenceDirectives.length > 0 ||
    program.getSyntacticDiagnostics(source).length > 0;
  return {
    analysis: {
      ...facts,
      unsupportedForms: [
        ...facts.unsupportedForms,
        ...(invalid ? ["workflow-shape"] : []),
        ...(facts.directEffects.length === 0 && !passiveCandidateModule(source)
          ? ["module-initialization"]
          : []),
      ],
    },
    installedExports: exportSnapshot(modules, checker),
  };
}
