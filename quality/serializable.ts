import ts from "typescript";

interface Visit {
  readonly checker: ts.TypeChecker;
  readonly seen: Set<ts.Type>;
}

export function serializableType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return serializable(type, { checker, seen: new Set<ts.Type>() });
}

function serializable(type: ts.Type, visit: Visit): boolean {
  const { checker, seen } = visit;
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
    return type.types.every((member) => serializable(member, visit));
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  if (seen.has(type)) return true;
  seen.add(type);
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return !!element && serializable(element, visit);
  }
  return serializableObject(type, visit);
}

function serializableObject(type: ts.Type, visit: Visit): boolean {
  const { checker } = visit;
  if (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  )
    return false;
  if (type.getSymbol()?.declarations?.some(ts.isClassLike)) return false;
  const indexes = checker.getIndexInfosOfType(type);
  if (indexes.some((index) => !serializable(index.type, visit))) return false;
  const properties = type.getProperties();
  if (properties.length === 0 && indexes.length === 0) return false;
  return properties.every((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return (
      !!declaration &&
      serializable(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        visit,
      )
    );
  });
}
