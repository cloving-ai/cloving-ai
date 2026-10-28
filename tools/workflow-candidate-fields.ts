import ts from "typescript";

export function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

export function propertyInitializer(node: ts.Node | undefined, field: string) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find(
    (entry) => entry.name && propertyName(entry.name) === field,
  );
  return property && ts.isPropertyAssignment(property)
    ? property.initializer
    : undefined;
}

export function literalField(node: ts.Node | undefined, field: string) {
  const value = propertyInitializer(node, field);
  return value && ts.isStringLiteral(value) ? value.text : null;
}

export function invalidFields(object: ts.ObjectLiteralExpression): boolean {
  const names = object.properties.map(
    (entry) => entry.name && propertyName(entry.name),
  );
  return (
    names.includes(undefined) ||
    new Set(names).size !== names.length ||
    object.properties.some((entry) => !ts.isPropertyAssignment(entry))
  );
}
