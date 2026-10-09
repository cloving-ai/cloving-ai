import ts from "typescript";
import { dirname, join, resolve } from "node:path";

export function compilerConfiguration(file: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    file,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          `Compiler configuration: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        );
      },
    },
  );
  if (!parsed || parsed.errors.length > 0)
    throw new Error(
      `Compiler configuration: ${parsed?.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n") ?? "missing"}`,
    );
  return parsed;
}

export function compilerProgram(
  directory: string,
  files: readonly string[],
  options: { readonly trustedConfiguration?: string } = {},
): ts.Program {
  const configuration =
    options.trustedConfiguration ?? join(directory, "tsconfig.json");
  const parsed = compilerConfiguration(configuration);
  const configured = [
    ...(options.trustedConfiguration ? files : parsed.fileNames),
  ]
    .map((file) => resolve(file))
    .sort();
  const expected = [...files].map((file) => resolve(file)).sort();
  if (
    expected.length === 0 ||
    JSON.stringify(configured) !== JSON.stringify(expected)
  )
    throw new Error("Compiler inventory does not match discovered sources");
  const program = ts.createProgram(configured, {
    ...parsed.options,
    ...(options.trustedConfiguration
      ? {
          rootDir: directory,
          outDir: join(directory, "dist"),
          typeRoots: [join(dirname(configuration), "node_modules/@types")],
        }
      : {}),
    noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0)
    throw new Error(
      `Compiler diagnostics:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => directory, getCanonicalFileName: (name) => name, getNewLine: () => "\n" })}`,
    );
  return program;
}
