import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import metadata from "#package" with { type: "json" };
import { workflowHelperPath } from "../src/workflow-candidate.ts";

export const candidatePackageRoot = dirname(
  fileURLToPath(import.meta.resolve("#package")),
);

export interface CandidatePackageOptions {
  readonly packageRoot?: string;
  readonly helpers?: Readonly<Record<string, string>>;
}

export function resolvedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

export function candidateProgram(
  text: string,
  installed: CandidatePackageOptions = {},
): {
  readonly program: ts.Program;
  readonly source: ts.SourceFile;
  readonly sources: readonly ts.SourceFile[];
  readonly modules: ReadonlyMap<string, ts.SourceFile>;
} {
  const packageRoot = resolve(installed.packageRoot ?? candidatePackageRoot);
  const candidate = join(packageRoot, "candidate.ts");
  const sources = new Map([[candidate, text]]);
  for (const [name, content] of Object.entries(installed.helpers ?? {})) {
    if (workflowHelperPath("candidate.ts", `./${name}`) !== name)
      throw new Error("invalid-workflow-helper");
    sources.set(join(packageRoot, name), content);
  }
  const entries = new Map(
    Object.entries(metadata.exports).map(([name, entry]) => [
      `cloving${name.slice(1)}`,
      resolve(packageRoot, entry.types),
    ]),
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    types: [],
    strict: true,
    noEmit: true,
  };
  const host = trustedHost({ sources, options, entries, packageRoot });
  const program = ts.createProgram(
    [...sources.keys(), ...entries.values()],
    options,
    host,
  );
  const source = program.getSourceFile(candidate);
  if (!source) throw new Error("candidate-analysis-unavailable");
  const modules = new Map<string, ts.SourceFile>();
  for (const [name, file] of entries) {
    const declaration = program.getSourceFile(file);
    if (!declaration) throw new Error("candidate-surface-unavailable");
    modules.set(name, declaration);
  }
  return {
    program,
    source,
    modules,
    sources: [...sources.keys()].map((name) => {
      const entry = program.getSourceFile(name);
      if (!entry) throw new Error("candidate-analysis-unavailable");
      return entry;
    }),
  };
}

function trustedHost(input: {
  readonly sources: ReadonlyMap<string, string>;
  readonly options: ts.CompilerOptions;
  readonly entries: ReadonlyMap<string, string>;
  readonly packageRoot: string;
}): ts.CompilerHost {
  const { sources, options, entries, packageRoot } = input;
  const libraries = dirname(ts.getDefaultLibFilePath(options)) + sep;
  const declarations = join(packageRoot, "dist/src") + sep;
  const readFile = (file: string): string | undefined => {
    if (sources.has(file)) return sources.get(file);
    const absolute = resolve(file);
    if (!absolute.endsWith(".d.ts")) return undefined;
    if (!absolute.startsWith(libraries) && !absolute.startsWith(declarations))
      return undefined;
    return ts.sys.readFile(absolute);
  };
  const host = ts.createCompilerHost(options);
  host.readFile = readFile;
  host.fileExists = (file) => readFile(file) !== undefined;
  host.getSourceFile = (file, languageVersion) => {
    const content = readFile(file);
    return content === undefined
      ? undefined
      : ts.createSourceFile(file, content, languageVersion, true);
  };
  host.resolveModuleNameLiterals = (names, containingFile) =>
    names.map(({ text: name }) => {
      const installed = entries.get(name);
      if (installed)
        return {
          resolvedModule: {
            resolvedFileName: installed,
            extension: ts.Extension.Dts,
          },
        };
      if (sources.has(containingFile)) {
        const importer = containingFile
          .slice(packageRoot.length + 1)
          .split(sep)
          .join("/");
        const local = workflowHelperPath(importer, name);
        const target = local && join(packageRoot, local);
        return {
          resolvedModule:
            target && sources.has(target)
              ? { resolvedFileName: target, extension: ts.Extension.Ts }
              : undefined,
        };
      }
      return ts.resolveModuleName(name, containingFile, options, host);
    });
  return host;
}
