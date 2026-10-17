export const palette = {
  light: {
    bg: "#D6E7DF",
    surface: "#F4FAF6",
    "surface-2": "#E4F0E9",
    ink: "#0E2310",
    muted: "#405C4C",
    line: "#B7D2C4",
    accent: "#0BBF64",
    "accent-strong": "#026B3B",
    "accent-tint": "rgba(11,191,100,0.14)",
    "on-accent": "#052213",
    warn: "#8A5A00",
    "warn-tint": "rgba(214,150,20,0.16)",
    "code-bg": "#0F1D16",
    "code-head": "#15271E",
    "code-fg": "#D5E6DC",
    "code-line": "#24392E",
    "code-muted": "#86A394",
    shadow: "0 18px 50px rgba(14,35,16,0.16)",
    bad: "#C02B2B",
    "bad-tint": "rgba(192,43,43,0.14)",
  },
  dark: {
    bg: "#141C18",
    surface: "#1B2520",
    "surface-2": "#22302A",
    ink: "#E6F2EB",
    muted: "#A2BAAD",
    line: "#2E4037",
    accent: "#0BBF64",
    "accent-strong": "#45DD92",
    "accent-tint": "rgba(11,191,100,0.18)",
    "on-accent": "#052213",
    warn: "#F0C062",
    "warn-tint": "rgba(240,192,98,0.14)",
    "code-bg": "#0A1410",
    "code-head": "#112019",
    "code-fg": "#D5E6DC",
    "code-line": "#1F3329",
    "code-muted": "#86A394",
    shadow: "0 18px 50px rgba(0,0,0,0.45)",
    bad: "#FF7B72",
    "bad-tint": "rgba(255,123,114,0.14)",
  },
};

type Color = readonly number[];

export function rgb(color: string): Color {
  if (color.startsWith("#"))
    return [1, 3, 5].map((index) =>
      parseInt(color.slice(index, index + 2), 16),
    );
  return (color.match(/[\d.]+/g) ?? []).map(Number);
}

export function over(color: string, background: Color): Color {
  const channels = rgb(color);
  const alpha = channels[3] ?? 1;
  return channels
    .slice(0, 3)
    .map(
      (channel, index) =>
        channel * alpha + (background[index] ?? 0) * (1 - alpha),
    );
}

function luminance(color: Color): number {
  const weights = [0.2126, 0.7152, 0.0722];
  let sum = 0;
  for (const [index, channel] of color.entries()) {
    const value = channel / 255;
    const linear =
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    sum += linear * (weights[index] ?? 0);
  }
  return sum;
}

export function contrast(foreground: Color, background: Color): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
