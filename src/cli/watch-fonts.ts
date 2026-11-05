const families = [
  { family: "Barlow", file: "barlow", weights: [400, 500, 600, 700] },
  {
    family: "Barlow Semi Condensed",
    file: "barlow-semi-condensed",
    weights: [700],
  },
  { family: "Fira Code", file: "fira-code", weights: [400, 500] },
  { family: "Heebo", file: "heebo", weights: [500, 700, 800] },
  {
    family: "Pixelify Sans",
    file: "pixelify-sans",
    weights: [400, 500, 600, 700],
  },
  { family: "Silkscreen", file: "silkscreen", weights: [700] },
  {
    family: "Space Grotesk",
    file: "space-grotesk",
    weights: [400, 500, 600, 700],
  },
] as const;

const faces = families.flatMap(({ family, file, weights }) =>
  weights.map((weight) => ({
    family,
    weight: String(weight),
    name: `${file}-latin-${String(weight)}-normal.woff2`,
  })),
);

export const fontNames: readonly string[] = faces.map((face) => face.name);

export const fontFaces = faces
  .map(
    (face) =>
      `@font-face { font-family: "${face.family}"; font-style: normal; font-weight: ${face.weight}; font-display: swap; src: url("/watch-fonts-v1/${face.name}") format("woff2"); }`,
  )
  .join("\n");
