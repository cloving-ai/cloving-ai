import type { Fields } from "../src/protocol.ts";

export function workshopTheme(): Fields {
  return {
    color: {
      page: {
        $type: "color",
        $value: {
          colorSpace: "srgb",
          components: [0.843, 0.855, 0.835],
          hex: "#D7DAD5",
        },
      },
      state: {
        running: {
          $type: "color",
          $value: {
            colorSpace: "srgb",
            components: [0.122, 0.616, 0.333],
            hex: "#1F9D55",
          },
        },
      },
    },
    shape: {
      cut: { $type: "dimension", $value: { value: 7, unit: "px" } },
    },
    $extensions: {
      "ai.cloving.theme": {
        name: "Workshop",
        colorScheme: "light",
        art: {
          station: { src: "assets/bench.svg", mode: "image", pixelated: true },
        },
        words: { "completed.unit": { one: "shoe", other: "shoes" } },
      },
    },
  };
}

export function themeData(theme: Fields): Fields {
  const extensions = theme["$extensions"];
  if (typeof extensions !== "object" || extensions === null)
    throw new Error("missing-extensions");
  const data: unknown = Reflect.get(extensions, "ai.cloving.theme");
  if (typeof data !== "object" || data === null)
    throw new Error("missing-theme-data");
  return Object.fromEntries(Object.entries(data));
}

export function withTokens(tokens: Fields): Fields {
  return { ...tokens, $extensions: workshopTheme()["$extensions"] };
}

export function withThemeData(changes: Fields): Fields {
  const theme = workshopTheme();
  return {
    ...theme,
    $extensions: { "ai.cloving.theme": { ...themeData(theme), ...changes } },
  };
}
