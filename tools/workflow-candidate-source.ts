import ts from "typescript";
import { dirname, relative, sep } from "node:path";
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
import { helperEffectTotals } from "./workflow-candidate-helper-counts.ts";
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

function mergeHelpers(
  modules: ReadonlyMap<string, ts.SourceFile>,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  return [
    ["merge-when-green", "mergeWhenGreen"],
    ["merge-by-person", "mergeByPerson"],
  ].flatMap(([module, name]) => {
    const symbol = protectedHelper(modules, {
      checker,
      subpath: `cloving/workflows/steps/${String(module)}`,
      name: String(name),
    });
    return symbol === undefined ? [] : [symbol];
  });
}

export function analyzeWorkflowCandidate(
  text: string,
  installed: CandidatePackageOptions = {},
): {
  readonly analysis: CandidateAnalysis;
  readonly installedExports: InstalledWorkflowExports;
} {
  const { program, source, sources, modules } = candidateProgram(
    text,
    installed,
  );
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
    commandSymbol: protectedHelper(modules, {
      checker,
      subpath: "cloving/workflows/steps/run-command",
      name: "runCommand",
    }),
    reviewSymbol: protectedHelper(modules, {
      checker,
      subpath: "cloving/workflows/steps/review-by-agent",
      name: "reviewByAgent",
    }),
    mergeSymbols: mergeHelpers(modules, checker),
  };
  const facts = sources.map((entry) =>
    analyzedSource(
      { ...symbols, source: entry },
      { program, workflow: source },
    ),
  );
  return {
    analysis: combineFacts({
      localSources: Object.keys(installed.helpers ?? {}),
      facts,
      expanded: helperEffectTotals({
        symbols: { ...symbols, source },
        sources,
      }),
    }),
    installedExports: exportSnapshot(modules, checker),
  };
}

function analyzedSource(
  symbols: CandidateSymbols,
  input: { readonly program: ts.Program; readonly workflow: ts.SourceFile },
): CandidateAnalysis {
  const { source } = symbols;
  const facts = sourceFacts(symbols);
  const kind = source === input.workflow ? "workflow" : "helper";
  const path = relative(dirname(input.workflow.fileName), source.fileName)
    .split(sep)
    .join("/");
  const invalid =
    source.referencedFiles.length > 0 ||
    source.typeReferenceDirectives.length > 0 ||
    source.libReferenceDirectives.length > 0 ||
    input.program.getSyntacticDiagnostics(source).length > 0;
  return {
    ...facts,
    imports: facts.imports.map((entry) =>
      kind === "workflow" ? entry : { ...entry, source: path },
    ),
    unsupportedForms: [
      ...facts.unsupportedForms,
      ...(invalid || (kind === "workflow" && !workflowShape(source))
        ? ["workflow-shape"]
        : []),
      ...(facts.directEffects.length === 0 &&
      !passiveCandidateModule(source, kind)
        ? ["module-initialization"]
        : []),
    ],
  };
}

function combineFacts(input: {
  readonly localSources: readonly string[];
  readonly facts: readonly CandidateAnalysis[];
  readonly expanded: ReturnType<typeof helperEffectTotals>;
}): CandidateAnalysis {
  const { localSources, facts } = input;
  return {
    localSources,
    imports: facts.flatMap((entry) => entry.imports),
    effects: facts.flatMap((entry) => entry.effects),
    directEffects: facts.flatMap((entry) => entry.directEffects),
    unsupportedForms: [
      ...facts.flatMap((entry) => entry.unsupportedForms),
      ...input.expanded.unsupportedForms,
    ],
    knownCallCount:
      input.expanded.totals?.knownCallCount ??
      facts.reduce((total, entry) => total + entry.knownCallCount, 0),
    knownUnitTotal:
      input.expanded.totals?.knownUnitTotal ??
      facts.reduce((total, entry) => total + entry.knownUnitTotal, 0),
  };
}
