import type { IncomingMessage } from "node:http";
import { notFound, type Reply } from "./watch-reply.ts";
import { readFile } from "node:fs/promises";

const fontFiles = new Map(
  [
    "fira-code-latin-400-normal.woff2",
    "fira-code-latin-500-normal.woff2",
    "heebo-latin-500-normal.woff2",
    "heebo-latin-700-normal.woff2",
    "heebo-latin-800-normal.woff2",
    "space-grotesk-latin-400-normal.woff2",
    "space-grotesk-latin-500-normal.woff2",
    "space-grotesk-latin-600-normal.woff2",
    "space-grotesk-latin-700-normal.woff2",
  ].map((name) => [
    `/watch-fonts-v1/${name}`,
    new URL(`assets/watch-fonts/${name}`, import.meta.resolve("#package")),
  ]),
);
export async function fontReply(
  request: IncomingMessage,
): Promise<Reply | null> {
  const fontFile = fontFiles.get(request.url ?? "");
  if (fontFile === undefined)
    return request.url?.startsWith("/watch-fonts-v1/") ? notFound : null;
  if (request.method !== "GET") return notFound;
  return {
    status: 200,
    type: "font/woff2",
    body: await readFile(fontFile),
    cache: "public, max-age=31536000, immutable",
  };
}
