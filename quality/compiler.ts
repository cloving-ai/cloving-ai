import ts from "typescript";
import { join, resolve } from "node:path";

export function compilerProgram(
  directory: string,
  files: readonly string[],
): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(directory, "tsconfig.json"),
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
  const configured = [...parsed.fileNames].map((file) => resolve(file)).sort();
  const expected = [...files].map((file) => resolve(file)).sort();
  if (
    expected.length === 0 ||
    JSON.stringify(configured) !== JSON.stringify(expected)
  )
    throw new Error("Compiler inventory does not match discovered sources");
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0)
    throw new Error(
      `Compiler diagnostics:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => directory, getCanonicalFileName: (name) => name, getNewLine: () => "\n" })}`,
    );
  return program;
}
