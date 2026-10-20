import { request } from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const fontSources = [
  {
    path: "fira-code-latin-400-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/fira-code/-/fira-code-5.3.0.tgz",
    sourceMember: "package/files/fira-code-latin-400-normal.woff2",
    package: "@fontsource/fira-code",
    version: "5.3.0",
    bytes: 23312,
    sha256: "6dc9da171ccea71d525379ee1cbf51d143e31acac330a251bb71b3d6060e687c",
  },
  {
    path: "fira-code-latin-500-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/fira-code/-/fira-code-5.3.0.tgz",
    sourceMember: "package/files/fira-code-latin-500-normal.woff2",
    package: "@fontsource/fira-code",
    version: "5.3.0",
    bytes: 23316,
    sha256: "9e4da5ad2c147be02544df5a732d22830a82b1e9800dc06267ba656f5c40f7e9",
  },
  {
    path: "fira-code-OFL.md",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/fira-code/-/fira-code-5.3.0.tgz",
    sourceMember: "package/LICENSE",
    package: "@fontsource/fira-code",
    version: "5.3.0",
    bytes: 4389,
    sha256: "126cd7bf732b86f42885f1fbf682e6aeea456672c7fdb99f2d557ec44e468a28",
  },
  {
    path: "heebo-latin-500-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/heebo/-/heebo-5.3.0.tgz",
    sourceMember: "package/files/heebo-latin-500-normal.woff2",
    package: "@fontsource/heebo",
    version: "5.3.0",
    bytes: 12312,
    sha256: "aa1ea48851b81ac859cf5bcb0e121b596d6b9386dbb9a3f7cd01af3e997201ae",
  },
  {
    path: "heebo-latin-700-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/heebo/-/heebo-5.3.0.tgz",
    sourceMember: "package/files/heebo-latin-700-normal.woff2",
    package: "@fontsource/heebo",
    version: "5.3.0",
    bytes: 12216,
    sha256: "2dd5f140b9902257dc0f38e89f47f79d40b31438abef118637d916861fd370bb",
  },
  {
    path: "heebo-latin-800-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/heebo/-/heebo-5.3.0.tgz",
    sourceMember: "package/files/heebo-latin-800-normal.woff2",
    package: "@fontsource/heebo",
    version: "5.3.0",
    bytes: 12132,
    sha256: "4890f322303544cf75def54d1065880f017dfe173f15d1b89a1a216e9855fe58",
  },
  {
    path: "heebo-OFL.md",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/heebo/-/heebo-5.3.0.tgz",
    sourceMember: "package/LICENSE",
    package: "@fontsource/heebo",
    version: "5.3.0",
    bytes: 4379,
    sha256: "50ac3e340fcd4822b2904413d14b457e02392f0bef38cd790e88da82014be44f",
  },
  {
    path: "space-grotesk-latin-400-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/space-grotesk/-/space-grotesk-5.3.0.tgz",
    sourceMember: "package/files/space-grotesk-latin-400-normal.woff2",
    package: "@fontsource/space-grotesk",
    version: "5.3.0",
    bytes: 13388,
    sha256: "65fd17fcbd2e2f522940b5f67ead3d23329e02891aa5495e74d11a499c0b0673",
  },
  {
    path: "space-grotesk-latin-500-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/space-grotesk/-/space-grotesk-5.3.0.tgz",
    sourceMember: "package/files/space-grotesk-latin-500-normal.woff2",
    package: "@fontsource/space-grotesk",
    version: "5.3.0",
    bytes: 13312,
    sha256: "1b1a8131d9edf975d9decee81e2f2bf504812f7a4f498e5500f28a613e22e64c",
  },
  {
    path: "space-grotesk-latin-600-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/space-grotesk/-/space-grotesk-5.3.0.tgz",
    sourceMember: "package/files/space-grotesk-latin-600-normal.woff2",
    package: "@fontsource/space-grotesk",
    version: "5.3.0",
    bytes: 13284,
    sha256: "685bbbf69fa616df1ef81847c85fc76be097ddfb3468ff2257be54511ab3130f",
  },
  {
    path: "space-grotesk-latin-700-normal.woff2",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/space-grotesk/-/space-grotesk-5.3.0.tgz",
    sourceMember: "package/files/space-grotesk-latin-700-normal.woff2",
    package: "@fontsource/space-grotesk",
    version: "5.3.0",
    bytes: 12840,
    sha256: "35f8aec56cfd5cbfdb03cc68733a54a0b05bb3617ffcd5fd332badc0b045ca55",
  },
  {
    path: "space-grotesk-OFL.md",
    sourceArchive:
      "https://registry.npmjs.org/@fontsource/space-grotesk/-/space-grotesk-5.3.0.tgz",
    sourceMember: "package/LICENSE",
    package: "@fontsource/space-grotesk",
    version: "5.3.0",
    bytes: 4401,
    sha256: "18a4de52385f6b988782639d5d0cc1326e5a8c2de9a7f01d7b20d9aedcc60943",
  },
] as const;

export const fontNames = fontSources
  .filter((file) => file.path.endsWith(".woff2"))
  .map((file) => file.path);

export async function packagedFontFiles(product: string): Promise<void> {
  const folder = join(product, "assets/watch-fonts");
  const manifest = await readFile(join(folder, "manifest.json"));
  const parsed: unknown = JSON.parse(manifest.toString());
  assert.deepEqual(parsed, { files: fontSources });
  assert.deepEqual(
    (await readdir(folder)).sort(),
    [...fontSources.map((file) => file.path), "manifest.json"].sort(),
  );
  let total = 0;
  let fonts = 0;
  for (const file of fontSources) {
    const bytes = await readFile(join(folder, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    total += bytes.length;
    if (file.path.endsWith(".woff2")) fonts += bytes.length;
  }
  assert.equal(fonts, 136112);
  assert.equal(total, 149281);
  assert.ok(total + manifest.length <= 163840);
  const metadata: unknown = JSON.parse(
    await readFile(join(product, "package.json"), "utf8"),
  );
  assert.ok(
    metadata !== null &&
      typeof metadata === "object" &&
      "files" in metadata &&
      Array.isArray(metadata.files),
  );
  assert.deepEqual(
    metadata.files.filter(
      (path: unknown) => typeof path === "string" && path.startsWith("assets/"),
    ),
    [
      ...fontSources.map((file) => `assets/watch-fonts/${file.path}`),
      "assets/watch-fonts/manifest.json",
    ],
  );
}

export async function servedFonts(
  address: string,
  product: string,
): Promise<void> {
  for (const name of fontNames) {
    const response = await fetch(`${address}watch-fonts-v1/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("content-type"), "font/woff2");
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile(join(product, "assets/watch-fonts", name)),
    );
  }
}

export function rawFontStatus(
  address: string,
  target: { readonly path: string; readonly method?: string },
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    const exchange = request(
      { hostname: url.hostname, port: url.port, ...target },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode);
        });
      },
    );
    exchange.once("error", reject);
    exchange.end();
  });
}
