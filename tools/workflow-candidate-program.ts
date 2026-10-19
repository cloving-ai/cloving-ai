import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import metadata from "#package" with { type: "json" };

export const candidatePackageRoot = dirname(
  fileURLToPath(import.meta.resolve("#package")),
);

export function resolvedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

export function candidateProgram(text: string): {
  readonly program: ts.Program;
  readonly source: ts.SourceFile;
  readonly modules: ReadonlyMap<string, ts.SourceFile>;
} {
  const candidate = join(candidatePackageRoot, "candidate.ts");
  const entries = new Map(
    Object.entries(metadata.exports).map(([name, entry]) => [
      `cloving${name.slice(1)}`,
      resolve(candidatePackageRoot, entry.types),
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
  const host = trustedHost({ candidate, text, options, entries });
  const program = ts.createProgram(
    [candidate, ...entries.values()],
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
  return { program, source, modules };
}

function trustedHost(input: {
  readonly candidate: string;
  readonly text: string;
  readonly options: ts.CompilerOptions;
  readonly entries: ReadonlyMap<string, string>;
}): ts.CompilerHost {
  const { candidate, text, options, entries } = input;
  const libraries = dirname(ts.getDefaultLibFilePath(options)) + sep;
  const declarations = join(candidatePackageRoot, "dist/src") + sep;
  const readFile = (file: string): string | undefined => {
    if (file === candidate) return text;
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
      if (containingFile === candidate) return { resolvedModule: undefined };
      return ts.resolveModuleName(name, containingFile, options, host);
    });
  return host;
}
