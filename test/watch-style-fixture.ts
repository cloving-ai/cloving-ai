import assert from "node:assert/strict";
import { pageDocument } from "../src/cli/watch-page.ts";

export const css =
  pageDocument().split("<style>")[1]?.split("</style>")[0] ?? "";
export const rules = css.replaceAll(/\n[ \t]+/g, "\n");
export function rule(selector: string): string {
  const start = rules.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, selector);
  return rules.slice(start, rules.indexOf("}", start));
}

const light = {
  "color-page": "#D6E7DF",
  "color-surface": "#F4FAF6",
  "color-panel": "#E4F0E9",
  "color-ink": "#0E2310",
  "color-muted": "#405C4C",
  "color-line": "#B7D2C4",
  "color-accent": "#0BBF64",
  "color-accent-strong": "#026B3B",
  "color-on-accent": "#052213",
  "color-warn": "#8A5A00",
  "color-bad": "#C02B2B",
  "color-code-background": "#0F1D16",
  "color-code-header": "#15271E",
  "color-code-text": "#D5E6DC",
  "color-code-line": "#24392E",
  "color-code-muted": "#86A394",
};
const dark = {
  "color-page": "#141C18",
  "color-surface": "#1B2520",
  "color-panel": "#22302A",
  "color-ink": "#E6F2EB",
  "color-muted": "#A2BAAD",
  "color-line": "#2E4037",
  "color-accent": "#0BBF64",
  "color-accent-strong": "#45DD92",
  "color-on-accent": "#052213",
  "color-warn": "#F0C062",
  "color-bad": "#FF7B72",
  "color-code-background": "#0A1410",
  "color-code-header": "#112019",
  "color-code-text": "#D5E6DC",
  "color-code-line": "#1F3329",
  "color-code-muted": "#86A394",
};

function tint(color: string, share: number): string {
  return `rgba(${rgb(color).join(",")},${String(share)})`;
}

function tinted(tokens: typeof light) {
  return {
    ...tokens,
    "accent-tint": tint(tokens["color-accent"], 0.16),
    "warn-tint": tint(tokens["color-warn"], 0.12),
    "bad-tint": tint(tokens["color-bad"], 0.14),
  };
}

export const colorTokens = { light, dark };
export const palette = { light: tinted(light), dark: tinted(dark) };

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
