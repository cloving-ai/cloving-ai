import ts from "typescript";

export interface ReferenceContext {
  readonly parent: ts.Node | undefined;
  readonly checker: ts.TypeChecker;
  readonly profile?: "candidate";
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

const candidateNames = new Set([
  "Buffer",
  "document",
  "screen",
  "history",
  "location",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "Deno",
  "Bun",
  "__dirname",
  "__filename",
  "File",
  "FileReader",
  "readFile",
  "writeFile",
  "XMLHttpRequest",
  "EventSource",
  "WebTransport",
  "BroadcastChannel",
  "MessageChannel",
  "MessagePort",
  "postMessage",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "requestAnimationFrame",
  "requestIdleCallback",
  "cancelAnimationFrame",
  "cancelIdleCallback",
  "AbortSignal",
  "Reflect",
  "Proxy",
  "constructor",
  "WebAssembly",
]);

const reflectiveProperties = new Set(["constructor", "__proto__", "prototype"]);

const candidateProperties = new Set([
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
]);

function localBinding(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(
    (declaration) =>
      !declaration.getSourceFile().isDeclarationFile &&
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) ===
        0,
  );
}

export function referenceSymbol(
  node: ts.Identifier,
  context: ReferenceContext,
): ts.Symbol | undefined {
  const { parent, checker } = context;
  if (
    parent &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent)) &&
    parent.name === node
  )
    return undefined;
  if (parent && ts.isShorthandPropertyAssignment(parent))
    return checker.getShorthandAssignmentValueSymbol(parent);
  return checker.getSymbolAtLocation(node);
}

function referenceIdentifier(
  node: ts.Node,
  parent: ts.Node | undefined,
): node is ts.Identifier {
  if (!ts.isIdentifier(node)) return false;
  if (!parent) return true;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent)) &&
    parent.name === node
  )
    return false;
  return !ts.isImportSpecifier(parent);
}

function restrictedAmbientName(
  name: string,
  context: ReferenceContext,
): boolean {
  return (
    ambientNames.has(name) ||
    name === "Math" ||
    (context.profile === "candidate" && candidateNames.has(name))
  );
}

function pureMathAccess(node: ts.Node, parent: ts.Node | undefined): boolean {
  return (
    !!parent &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.name.text !== "random"
  );
}

function ambientReference(node: ts.Node, context: ReferenceContext): boolean {
  const { parent } = context;
  if (!referenceIdentifier(node, parent)) return false;
  if (!restrictedAmbientName(node.text, context)) return false;
  const candidate = context.profile === "candidate";
  const symbol = referenceSymbol(node, context);
  if ((!symbol && !candidate) || (symbol && localBinding(symbol))) return false;
  return node.text !== "Math" || !pureMathAccess(node, parent);
}

function reflectiveAccess(node: ts.Node, context: ReferenceContext): boolean {
  const candidate = context.profile === "candidate";
  const restricted = (name: string): boolean =>
    reflectiveProperties.has(name) ||
    (candidate && candidateProperties.has(name));
  if (ts.isPropertyAccessExpression(node)) return restricted(node.name.text);
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return restricted(node.argumentExpression.text);
  if (!candidate || !ts.isBindingElement(node)) return false;
  const name = node.propertyName ?? node.name;
  return (
    (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
    restricted(name.text)
  );
}

function dynamicCapability(node: ts.Node, checker: ts.TypeChecker): boolean {
  if (!ts.isElementAccessExpression(node)) return false;
  const target = checker.getTypeAtLocation(node.expression);
  return (
    target.getCallSignatures().length > 0 ||
    target.getConstructSignatures().length > 0
  );
}

export function typeOnlyEffectNode(node: ts.Node): boolean {
  return (
    (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  );
}

export function restrictedEffect(
  node: ts.Node,
  context: ReferenceContext,
): boolean {
  return (
    ambientReference(node, context) ||
    reflectiveAccess(node, context) ||
    dynamicCapability(node, context.checker)
  );
}

export function sourceEffectNodes(
  source: ts.SourceFile,
  context: Omit<ReferenceContext, "parent">,
): readonly ts.Node[] {
  const findings: ts.Node[] = [];
  function visit(node: ts.Node, parent?: ts.Node): void {
    if (typeOnlyEffectNode(node)) return;
    if (restrictedEffect(node, { ...context, parent })) findings.push(node);
    ts.forEachChild(node, (child) => {
      visit(child, node);
    });
  }
  visit(source);
  return findings;
}
