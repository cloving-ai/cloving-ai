import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { pageDocument } from "../src/cli/watch-page.ts";

const browserNames = [
  "document",
  "window",
  "location",
  "history",
  "navigator",
  "localStorage",
  "sessionStorage",
  "matchMedia",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "EventSource",
  "ResizeObserver",
  "IntersectionObserver",
  "MutationObserver",
  "CSS",
  "Element",
  "HTMLElement",
  "Node",
  "Event",
  "KeyboardEvent",
  "PointerEvent",
  "MouseEvent",
  "FocusEvent",
  "CustomEvent",
  "addEventListener",
  "removeEventListener",
  "scrollTo",
  "scrollY",
  "innerHeight",
  "innerWidth",
  "confirm",
  "alert",
  "undefined",
  "NaN",
  "Infinity",
  "arguments",
];

function pageScript(): string {
  const [, script = ""] =
    /<script type="module">([\s\S]*)<\/script>/.exec(pageDocument()) ?? [];
  return script;
}

function namedFunction(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  )
    return node.name?.text;
  return undefined;
}

function namedBinding(node: ts.Node): string | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node)
  )
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node))
    return node.name.text;
  return undefined;
}

function declaredName(node: ts.Node): string | undefined {
  return namedFunction(node) ?? namedBinding(node);
}

function memberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isPropertyAccessExpression(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent)
  )
    return parent.name === node;
  return ts.isImportSpecifier(parent) && parent.propertyName === node;
}

function labelName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  );
}

function referenceOnly(node: ts.Identifier): boolean {
  return (
    !memberName(node) &&
    !labelName(node) &&
    declaredName(node.parent) !== node.text
  );
}

function scriptNames(script: string): {
  readonly declared: ReadonlySet<string>;
  readonly referenced: ReadonlySet<string>;
} {
  const source = ts.createSourceFile(
    "page.mjs",
    script,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.JS,
  );
  const declared = new Set<string>();
  const referenced = new Set<string>();
  const visit = (node: ts.Node): void => {
    const name = declaredName(node);
    if (name !== undefined) declared.add(name);
    if (ts.isIdentifier(node) && referenceOnly(node)) referenced.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { declared, referenced };
}

await test("CLV-358 each name that the watch page script uses is defined in the script or is a global", () => {
  const { declared, referenced } = scriptNames(pageScript());
  const globals = new Set([
    ...Object.getOwnPropertyNames(globalThis),
    ...browserNames,
  ]);
  const missing = [...referenced].filter(
    (name) => !declared.has(name) && !globals.has(name),
  );
  assert.deepEqual(missing, []);
});

await test("CLV-358 the name check finds a helper that a listed function calls but the script does not define", () => {
  const { declared, referenced } = scriptNames(
    "function Shown(model) { return missingHelper(model); }",
  );
  assert.equal(declared.has("missingHelper"), false);
  assert.equal(referenced.has("missingHelper"), true);
});
