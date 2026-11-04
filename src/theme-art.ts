import { record, type Fields } from "./protocol.ts";
import { onlyKeys } from "./theme-tokens.ts";

export const artSlots: readonly string[] = [
  "floor",
  "header",
  "line-banner",
  "station",
  "run-token",
  "completed-badge",
];

const artKeys = ["src", "mode", "repeat", "pixelated"];
const modes: readonly unknown[] = ["image", "mask"];
const repeats: readonly unknown[] = ["none", "x", "y", "both"];
const assetPath = /^assets(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;
export const assetTypes: readonly string[] = [".svg", ".png", ".webp"];

function assetPathCodes(source: unknown): readonly string[] {
  if (
    typeof source !== "string" ||
    source.length > 200 ||
    !assetPath.test(source)
  )
    return ["invalid-asset-path"];
  return assetTypes.some((type) => source.endsWith(type))
    ? []
    : ["invalid-asset-type"];
}

function shapeCodes(slot: Fields): readonly string[] {
  const repeat = slot["repeat"];
  const pixelated = slot["pixelated"];
  const valid =
    onlyKeys(slot, artKeys) &&
    modes.includes(slot["mode"]) &&
    (repeat === undefined || repeats.includes(repeat)) &&
    (pixelated === undefined || typeof pixelated === "boolean");
  return valid ? [] : ["invalid-art"];
}

function slotCodes(value: unknown): readonly string[] {
  const slot = record(value);
  if (slot === undefined) return ["invalid-art"];
  return [...shapeCodes(slot), ...assetPathCodes(slot["src"])];
}

export function artCodes(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const art = record(value);
  if (art === undefined) return ["invalid-art"];
  return Object.entries(art).flatMap(([name, slot]) =>
    artSlots.includes(name) ? slotCodes(slot) : ["unknown-art-slot"],
  );
}

export function artAssets(value: unknown): readonly string[] {
  const sources = Object.entries(record(value) ?? {}).flatMap(
    ([name, slot]) => {
      const source = record(slot)?.["src"];
      return artSlots.includes(name) && assetPathCodes(source).length === 0
        ? [String(source)]
        : [];
    },
  );
  return [...new Set(sources)];
}
