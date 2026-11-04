import assert from "node:assert/strict";
import { test } from "node:test";
import { assetByteLimit, assetCodes } from "../src/theme-assets.ts";
import { testMilliseconds } from "./test-timing.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ");

function svg(body: string): Uint8Array {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${body}</svg>`,
  );
}

function sized(signature: Uint8Array, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(signature);
  return bytes;
}

const accepted: readonly (readonly [string, string, Uint8Array])[] = [
  [
    "a plain SVG file",
    "assets/bench.svg",
    svg('<rect width="8" height="8" fill="#1F9D55"/>'),
  ],
  [
    "an SVG file with inner references",
    "assets/bench.svg",
    svg(
      '<defs><linearGradient id="g"/></defs><use href="#g"/><rect fill="url(#g)" style="fill: url( \'#g\' )"/>',
    ),
  ],
  [
    "an SVG file with a UTF-8 declaration",
    "assets/bench.svg",
    new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><svg/>'),
  ],
  [
    "an SVG file with shapes, gradients, filters and text",
    "assets/bench.svg",
    svg(
      '<title>Bench &amp; vise</title><defs><linearGradient id="shade"><stop offset="0" stop-color="rgb(10, 20, 30)"/></linearGradient><filter id="soft"><feGaussianBlur stdDeviation="1"/></filter></defs><g transform="translate(1 2) rotate(45)" filter="url(#soft)" xml:space="preserve"><path d="M0 0L8 8" stroke="url(\'#shade\')"/><text x="1">A &lt; B</text></g>',
    ),
  ],
  [
    "an SVG file with spaces around the root",
    "assets/bench.svg",
    new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg>\n\t<g><g/></g>\r\n</svg>\n',
    ),
  ],
  ["a PNG file", "assets/floor.png", png],
  ["a WebP file", "assets/floor.webp", webp],
  ["a PNG file of 512 KB", "assets/floor.png", sized(png, assetByteLimit)],
];

for (const [description, path, bytes] of accepted)
  await test(`CLV-290 ${description} has no refusal code`, () => {
    assert.deepEqual(assetCodes({ path, bytes }), []);
  });

const text = (body: string): Uint8Array => new TextEncoder().encode(body);

const refused: readonly (readonly [
  string,
  string,
  Uint8Array,
  readonly string[],
])[] = [
  [
    "an SVG file with a script",
    "assets/a.svg",
    svg("<script>alert(1)</script>"),
    ["svg-script"],
  ],
  [
    "an SVG file with a prefixed script",
    "assets/a.svg",
    svg("<svg:script>alert(1)</svg:script>"),
    ["svg-script"],
  ],
  [
    "an SVG file with a script in a prefix that is not ASCII",
    "assets/a.svg",
    svg('<é:script xmlns:é="http://www.w3.org/2000/svg">alert(1)</é:script>'),
    ["svg-attribute", "svg-script"],
  ],
  [
    "an SVG file with an event attribute",
    "assets/a.svg",
    svg('<rect ONLOAD = "alert(1)"/>'),
    ["svg-event-attribute"],
  ],
  [
    "an SVG file with a prefixed event attribute",
    "assets/a.svg",
    svg('<rect xlink:onclick="alert(1)"/>'),
    ["svg-event-attribute"],
  ],
  [
    "an SVG file with a foreign object",
    "assets/a.svg",
    svg("<foreignObject><p>x</p></foreignObject>"),
    ["svg-element", "svg-foreign-object"],
  ],
  [
    "an SVG file with an external image",
    "assets/a.svg",
    svg('<image href="https://example.com/a.png"/>'),
    ["svg-element", "svg-external-reference"],
  ],
  [
    "an SVG file with an external link",
    "assets/a.svg",
    svg("<use xlink:href='other.svg#a'/>"),
    ["svg-external-reference"],
  ],
  [
    "an SVG file with an external url(",
    "assets/a.svg",
    svg('<rect style="fill:url(https://example.com/a)"/>'),
    ["svg-external-reference"],
  ],
  [
    "an SVG file with an image-set function",
    "assets/a.svg",
    svg('<rect style="fill:image-set(&quot;https://example.com/a&quot; 1x)"/>'),
    ["svg-attribute"],
  ],
  [
    "an SVG file with a style element",
    "assets/a.svg",
    svg("<style>@import 'a.css';</style>"),
    ["svg-element", "svg-external-reference"],
  ],
  [
    "an SVG file with a style sheet instruction",
    "assets/a.svg",
    text('<?xml-stylesheet href="#s"?><svg/>'),
    ["svg-external-reference", "svg-markup"],
  ],
  [
    "an SVG file that animates a link",
    "assets/a.svg",
    svg('<set attributeName="xlink:href" to="#b"/>'),
    ["svg-element"],
  ],
  [
    "an SVG file with a script link",
    "assets/a.svg",
    svg('<a href="javascript:alert(1)"><rect/></a>'),
    ["svg-element", "svg-external-reference", "svg-script"],
  ],
  [
    "an SVG file with an entity",
    "assets/a.svg",
    text('<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>'),
    ["svg-doctype", "svg-markup"],
  ],
  [
    "an SVG file with a character reference",
    "assets/a.svg",
    svg('<rect fill="&#117;rl(http://example.com/a)"/>'),
    ["svg-attribute", "svg-markup"],
  ],
  [
    "an SVG file with a comment",
    "assets/a.svg",
    svg("<rect/><!-- x -->"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a CDATA section",
    "assets/a.svg",
    svg("<text><![CDATA[x]]></text>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a CSS escape",
    "assets/a.svg",
    svg('<rect style="fill:u\\72l(http://example.com/a)"/>'),
    ["svg-attribute", "svg-markup"],
  ],
  [
    "an SVG file with an unquoted attribute",
    "assets/a.svg",
    svg("<rect fill=red/>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a tag that does not close",
    "assets/a.svg",
    svg("<rect fill='red'"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a Unicode space before the url( target",
    "assets/a.svg",
    svg(
      '<rect fill="url(\u00a0#p)" mask="url(\u3000#p)" style="cursor:url(\u2028#p),auto"/>',
    ),
    ["svg-external-reference"],
  ],
  [
    "an SVG file with an upper-case link attribute",
    "assets/a.svg",
    svg('<use HREF="http://example.com/a"/>'),
    ["svg-external-reference"],
  ],
  [
    "an SVG file with an XHTML frame",
    "assets/a.svg",
    svg(
      '<h:iframe xmlns:h="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/>',
    ),
    ["svg-attribute", "svg-element"],
  ],
  [
    "an SVG file with an XHTML image",
    "assets/a.svg",
    svg('<h:img srcset="http://example.com/a"/>'),
    ["svg-element"],
  ],
  [
    "an SVG file with another default namespace",
    "assets/a.svg",
    text('<svg xmlns="http://www.w3.org/1999/xhtml"/>'),
    ["svg-attribute"],
  ],
  [
    "an SVG file with a base address",
    "assets/a.svg",
    svg('<g xml:base="http://example.com/"/>'),
    ["svg-attribute"],
  ],
  [
    "an SVG file with a missing closing tag",
    "assets/a.svg",
    svg("<g>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a root that does not close",
    "assets/a.svg",
    text("<svg>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a mismatched closing tag",
    "assets/a.svg",
    svg("<g></text>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a closing tag and no opening tag",
    "assets/a.svg",
    text("</svg><svg/>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with two roots",
    "assets/a.svg",
    text("<svg/><svg/>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with text after the root",
    "assets/a.svg",
    text("<svg/>x"),
    ["svg-markup"],
  ],
  [
    "an SVG file with text before the root",
    "assets/a.svg",
    text("x<svg/>"),
    ["svg-markup"],
  ],
  [
    "an SVG file with a less-than sign in an attribute",
    "assets/a.svg",
    svg('<rect fill="a<b"/>'),
    ["svg-markup"],
  ],
  [
    "an SVG file with a duplicate attribute",
    "assets/a.svg",
    svg('<rect fill="red" fill="blue"/>'),
    ["svg-markup"],
  ],
  [
    "an SVG file with no svg element",
    "assets/a.svg",
    text("<html/>"),
    ["invalid-asset-type"],
  ],
  [
    "an SVG file with a NUL character",
    "assets/a.svg",
    svg("\u0000"),
    ["invalid-asset-type"],
  ],
  [
    "an SVG file that is not UTF-8",
    "assets/a.svg",
    Uint8Array.from([0xff, 0xfe, 0x3c, 0x00]),
    ["invalid-asset-type"],
  ],
  [
    "an SVG file with another encoding",
    "assets/a.svg",
    text('<?xml version="1.0" encoding="UTF-16"?><svg/>'),
    ["invalid-asset-type"],
  ],
  [
    "a PNG name with SVG content",
    "assets/a.png",
    svg(""),
    ["invalid-asset-type"],
  ],
  [
    "a WebP name with PNG content",
    "assets/a.webp",
    png,
    ["invalid-asset-type"],
  ],
  [
    "a PNG file larger than 512 KB",
    "assets/a.png",
    sized(png, assetByteLimit + 1),
    ["asset-too-large"],
  ],
];

for (const [description, path, bytes, expected] of refused)
  await test(`CLV-290 ${description} gives ${expected.join(" and ")}`, () => {
    assert.deepEqual(assetCodes({ path, bytes }), expected);
  });

await test("CLV-290 an SVG file of 512 KB with distinct attributes is checked in linear time", () => {
  const head = '<svg xmlns="http://www.w3.org/2000/svg"><rect';
  const names = Array.from(
    { length: 52_000 },
    (_value, index) => ` a${String(index)}=""`,
  );
  const bytes = new TextEncoder().encode(`${head}${names.join("")}/></svg>`);
  assert.ok(bytes.length <= assetByteLimit);
  const start = performance.now();
  assert.deepEqual(assetCodes({ path: "assets/a.svg", bytes }), []);
  assert.ok(performance.now() - start < testMilliseconds(1000));
});
