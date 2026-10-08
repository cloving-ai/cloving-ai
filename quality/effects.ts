import ts from "typescript";

export interface EffectFinding {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
}

const ambientNames = new Set([
  "globalThis",
  "global",
  "window",
  "self",
  "process",
  "Date",
  "performance",
  "fetch",
  "WebSocket",
  "Worker",
  "crypto",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "eval",
  "Function",
  "require",
  "console",
  "navigator",
  "Atomics",
  "SharedArrayBuffer",
  "WeakRef",
  "FinalizationRegistry",
  "Intl",
]);

function localBinding(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  return declarations.some(
    (declaration) =>
      !declaration.getSourceFile().isDeclarationFile &&
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) ===
        0,
  );
}

function referenceSymbol(
  node: ts.Identifier,
  parent: ts.Node | undefined,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (
    parent &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent)) &&
    parent.name === node
  )
    return;
  if (parent && ts.isShorthandPropertyAssignment(parent))
    return checker.getShorthandAssignmentValueSymbol(parent);
  return checker.getSymbolAtLocation(node);
}

function ambientReference(
  node: ts.Node,
  parent: ts.Node | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(node)) return false;
  if (!ambientNames.has(node.text) && node.text !== "Math") return false;
  const symbol = referenceSymbol(node, parent, checker);
  if (!symbol || localBinding(symbol)) return false;
  if (node.text !== "Math") return true;
  return (
    !parent ||
    !ts.isPropertyAccessExpression(parent) ||
    parent.expression !== node ||
    parent.name.text === "random"
  );
}

function dynamicCapability(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (ts.isPropertyAccessExpression(node))
    return ["constructor", "__proto__", "prototype"].includes(node.name.text);
  if (!ts.isElementAccessExpression(node)) return false;
  if (
    ts.isStringLiteralLike(node.argumentExpression) &&
    ["constructor", "__proto__", "prototype"].includes(
      node.argumentExpression.text,
    )
  )
    return true;
  const target = checker.getTypeAtLocation(node.expression);
  return (
    target.getCallSignatures().length > 0 ||
    target.getConstructSignatures().length > 0
  );
}

export function inspectEffects(
  program: ts.Program,
  files: readonly string[],
): EffectFinding[] {
  const checker = program.getTypeChecker();
  const findings: EffectFinding[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing-effect-source: ${file}`);
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node, parent?: ts.Node): void => {
      if (
        (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)
      )
        return;
      if (
        ambientReference(node, parent, checker) ||
        dynamicCapability(node, checker)
      )
        findings.push({
          rule: "restricted-effect",
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
      ts.forEachChild(node, (child) => {
        visit(child, node);
      });
    };
    visit(source);
  }
  return findings;
}
