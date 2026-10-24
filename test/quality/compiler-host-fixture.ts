import { createHash } from "node:crypto";
import ts from "typescript";

const documents = ts.createDocumentRegistry(
  ts.sys.useCaseSensitiveFileNames,
  ts.sys.getCurrentDirectory(),
);
const libraries = new Map<string, ts.LanguageService>();

function service(files: readonly string[], options: ts.CompilerOptions) {
  return ts.createLanguageService(
    {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...files],
      getScriptVersion: (file) =>
        createHash("sha256")
          .update(ts.sys.readFile(file) ?? "")
          .digest("hex"),
      getScriptSnapshot: (file) => {
        const text = ts.sys.readFile(file);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: ts.sys.getCurrentDirectory.bind(ts.sys),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      readFile: ts.sys.readFile.bind(ts.sys),
      fileExists: ts.sys.fileExists.bind(ts.sys),
      readDirectory: ts.sys.readDirectory.bind(ts.sys),
      directoryExists: ts.sys.directoryExists.bind(ts.sys),
      getDirectories: ts.sys.getDirectories.bind(ts.sys),
      ...(ts.sys.realpath === undefined
        ? {}
        : { realpath: ts.sys.realpath.bind(ts.sys) }),
    },
    documents,
  );
}

function retainLibraries(options: ts.CompilerOptions): void {
  const key = JSON.stringify([
    documents.getKeyForCompilationSettings(options),
    options.types,
    options.typeRoots,
    options.lib,
  ]);
  if (libraries.has(key)) return;
  const retained = service([ts.getDefaultLibFilePath(options)], options);
  retained.getProgram();
  libraries.set(key, retained);
}

export function fixtureProgram(
  files: readonly string[],
  options: ts.CompilerOptions,
): ts.Program {
  retainLibraries(options);
  const current = service(files, options);
  try {
    const program = current.getProgram();
    if (program === undefined) throw new Error("missing-fixture-program");
    return program;
  } finally {
    current.dispose();
  }
}
