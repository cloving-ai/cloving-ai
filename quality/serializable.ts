import ts from "typescript";

export function serializableType(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): boolean {
  const primitive =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never;
  if ((type.flags & primitive) !== 0) return true;
  if (type.isUnionOrIntersection())
    return type.types.every((member) =>
      serializableType(member, checker, seen),
    );
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (seen.has(type)) return true;
  seen.add(type);
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return !!element && serializableType(element, checker, seen);
  }
  return serializableObject(type, checker, seen);
}

function serializableObject(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
): boolean {
  if (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  )
    return false;
  if (type.getSymbol()?.declarations?.some(ts.isClassLike)) return false;
  const indexes = checker.getIndexInfosOfType(type);
  if (indexes.some((index) => !serializableType(index.type, checker, seen)))
    return false;
  const properties = type.getProperties();
  if (properties.length === 0 && indexes.length === 0) return false;
  return properties.every((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return (
      !!declaration &&
      serializableType(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        checker,
        seen,
      )
    );
  });
}
