export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("canonical-json-number: Only safe integers are allowed.");
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object")
    throw new Error("canonical-json-value: The value is not JSON.");
  const fields = Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
    );
  return `{${fields.join(",")}}`;
}
