import ts from "typescript";

export function fixtureCompiler(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const load = host.getSourceFile.bind(host);
  const declarations = new Map<string, ts.SourceFile>();
  host.getSourceFile = (file, version) => {
    const cached = declarations.get(file);
    if (cached && cached.text === host.readFile(file)) return cached;
    const source = load(file, version);
    if (source?.isDeclarationFile) declarations.set(file, source);
    return source;
  };
  return host;
}
