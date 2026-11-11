import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { MarkdownText } from "../src/cli/watch-markdown-view.ts";
import { entry } from "./turn-transcript-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { terminal } from "./watch-terminal-fixture.ts";

function markdown(text: string): string {
  return rendered(component(MarkdownText, { text }));
}

await test("CLV-355 agent text shows bold, italic and code text, headings, lists and fenced code as formatted text, with one block for each run of blank lines", () => {
  assert.equal(
    markdown(
      "**Video:** see `demo.mp4` and *the frames*.\n\n\n\n## Ideas\n1. **Before:** today\n2. Second\n\n- one\n- two\n\n```sh\nnpm test\n<b>\n```\nPlain line one\nline two",
    ),
    '<div class="markdown"><p><strong>Video:</strong> see <code>demo.mp4</code> and <em>the frames</em>.</p><h2>Ideas</h2><ol><li><strong>Before:</strong> today</li><li>Second</li></ol><ul><li>one</li><li>two</li></ul><pre class="md-code"><code>npm test\n&lt;b&gt;</code></pre><p>Plain line one\nline two</p></div>',
  );
});

await test("CLV-355 a numbered list that starts at 3 keeps its start, and an indented list shows inside the item above it", () => {
  assert.equal(
    markdown("3. third\n4. fourth\n   - inner"),
    '<div class="markdown"><ol start="3"><li>third</li><li>fourth<ul><li>inner</li></ul></li></ol></div>',
  );
});

await test("CLV-355 numbered substeps show as a nested list inside their main step, so the main steps keep the numbers 1 and 2", () => {
  assert.equal(
    markdown("1. First\n   1. a\n   2. b\n2. Second"),
    '<div class="markdown"><ol><li>First<ol><li>a</li><li>b</li></ol></li><li>Second</li></ol></div>',
  );
});

await test("CLV-355 a bulleted sublist shows inside its item, and a second sublist of another kind under the same item follows the first", () => {
  assert.equal(
    markdown("- one\n  - one a\n  - one b\n  1. step\n- two"),
    '<div class="markdown"><ul><li>one<ul><li>one a</li><li>one b</li></ul><ol><li>step</li></ol></li><li>two</li></ul></div>',
  );
});

await test("CLV-355 an indented line under a step stays in that step, so the steps keep the numbers 1 and 2", () => {
  assert.equal(
    markdown("1. First\n   More detail\n1. Second"),
    '<div class="markdown"><ol><li>First\nMore detail</li><li>Second</li></ol></div>',
  );
});

await test("CLV-355 one blank line between items keeps one list, and an indented paragraph after a blank line stays in its item", () => {
  assert.equal(
    markdown("- one\n\n- two\n\n  More about two\n- three"),
    '<div class="markdown"><ul><li>one</li><li>two<p>More about two</p></li><li>three</li></ul></div>',
  );
});

await test("CLV-355 a paragraph after a list and two blank lines between items end the list", () => {
  assert.equal(
    markdown("1. a\n\nAfter the list.\n\n1. b\n\n\n1. c"),
    '<div class="markdown"><ol><li>a</li></ol><p>After the list.</p><ol><li>b</li></ol><ol><li>c</li></ol></div>',
  );
});

await test("CLV-355 an indented code fence under a step stays in the step without the indent of the step", () => {
  assert.equal(
    markdown("1. Run:\n   ```sh\n   npm test\n     --watch\n   ```\n2. Done"),
    '<div class="markdown"><ol><li>Run:<pre class="md-code"><code>npm test\n  --watch</code></pre></li><li>Done</li></ol></div>',
  );
});

await test("CLV-355 a code fence directly after a list marker is code in that item, and the next step stays outside the code", () => {
  assert.equal(
    markdown("1. ```sh\n   npm test\n   ```\n2. Done"),
    '<div class="markdown"><ol><li><pre class="md-code"><code>npm test</code></pre></li><li>Done</li></ol></div>',
  );
});

await test("CLV-355 a code fence closes only on a fence of the same character that is at least as long, so a longer fence can hold a shorter one", () => {
  assert.equal(
    markdown("````md\n```js\ncode\n```\n````\nAfter the block."),
    '<div class="markdown"><pre class="md-code"><code>```js\ncode\n```</code></pre><p>After the block.</p></div>',
  );
  assert.equal(
    markdown("~~~\n```\n~~~\nAfter."),
    '<div class="markdown"><pre class="md-code"><code>```</code></pre><p>After.</p></div>',
  );
});

await test("CLV-355 an http or https link opens in a new tab, and any other link, HTML and a script stay plain text", () => {
  assert.equal(
    markdown(
      "[docs](https://example.com/a?b=1&c=2) [plain](http://example.com) [bad](javascript:alert(1)) [rel](//evil.example) <script>alert(1)</script> <img src=x onerror=alert(1)>",
    ),
    '<div class="markdown"><p><a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">docs</a> <a href="http://example.com" rel="noopener noreferrer" target="_blank">plain</a> [bad](javascript:alert(1)) [rel](//evil.example) &lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;</p></div>',
  );
});

await test("CLV-355 snake_case names, a single star in a sentence and code text with stars stay as they are", () => {
  assert.equal(
    markdown(
      "Set CLOVING_QUEUE_LANES to 8 * 2 and run `a*b*c` with my_file_name.",
    ),
    '<div class="markdown"><p>Set CLOVING_QUEUE_LANES to 8 * 2 and run <code>a*b*c</code> with my_file_name.</p></div>',
  );
});

const paragraph = (html: string): string =>
  `<div class="markdown"><p>${html}</p></div>`;

await test("CLV-355 combined and nested emphasis follows the CommonMark delimiter rules, with no stray stars", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["**bold and *italic***", "<strong>bold and <em>italic</em></strong>"],
    ["***text***", "<em><strong>text</strong></em>"],
    ["*foo**bar**baz*", "<em>foo<strong>bar</strong>baz</em>"],
    ["**foo*bar*baz**", "<strong>foo<em>bar</em>baz</strong>"],
    ["*foo *bar**", "<em>foo <em>bar</em></em>"],
    ["*foo**bar*", "<em>foo**bar</em>"],
    ["*(*foo*)*", "<em>(<em>foo</em>)</em>"],
    ["__strong__ and _em_", "<strong>strong</strong> and <em>em</em>"],
  ];
  for (const [text, html] of cases)
    assert.equal(markdown(text), paragraph(html), text);
});

await test("CLV-355 a star works inside a word, an underscore does not, and an unmatched run stays as text", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["foo*bar*", "foo<em>bar</em>"],
    ["snake_case_name", "snake_case_name"],
    ["_foo_bar_", "<em>foo_bar</em>"],
    ["**foo", "**foo"],
    ["**foo*", "*<em>foo</em>"],
    ["a * b ** c", "a * b ** c"],
  ];
  for (const [text, html] of cases)
    assert.equal(markdown(text), paragraph(html), text);
});

await test("CLV-355 text in square brackets with no link address stays as text, and a sublist before a blank line ends at the next item of its parent list", () => {
  assert.equal(
    markdown("[not a link] and [x](y z)"),
    paragraph("[not a link] and [x](y z)"),
  );
  assert.equal(
    markdown("- a\n  - b\n\n- c"),
    '<div class="markdown"><ul><li>a<ul><li>b</li></ul></li><li>c</li></ul></div>',
  );
});

await test("CLV-355 a backslash before ASCII punctuation shows the punctuation as plain text, and a backslash before another character stays", () => {
  assert.equal(
    markdown(
      "\\*literal\\* and \\_x\\_ and \\*\\*no\\*\\* and \\[a\\](https://example.com) and C:\\path and \\\\",
    ),
    '<div class="markdown"><p>*literal* and _x_ and **no** and [a](https://example.com) and C:\\path and \\</p></div>',
  );
});

await test("CLV-355 an escaped backtick opens no code text, and a backslash inside code text stays", () => {
  assert.equal(
    markdown("\\`not code\\` and `a\\*b` and \\``code`"),
    '<div class="markdown"><p>`not code` and <code>a\\*b</code> and `<code>code</code></p></div>',
  );
});

await test("CLV-355 code text opens with a run of backticks and closes on a run of the same length, drops one space at each end, and shows its text with no formatting", () => {
  assert.equal(
    markdown(
      "``a`b`` and `` `x` `` and `  ` and `**no** _x_ [l](https://example.com)`",
    ),
    '<div class="markdown"><p><code>a`b</code> and <code>`x`</code> and <code>  </code> and <code>**no** _x_ [l](https://example.com)</code></p></div>',
  );
  assert.equal(
    markdown("a `` b ` c"),
    '<div class="markdown"><p>a `` b ` c</p></div>',
  );
});

await test("CLV-355 a fence with no end shows the rest of the text as code, and _word_ shows in italics", () => {
  assert.equal(
    markdown("Use _this_ form:\n```\nnpm test\nnpm run build"),
    '<div class="markdown"><p>Use <em>this</em> form:</p><pre class="md-code"><code>npm test\nnpm run build</code></pre></div>',
  );
});

await test("CLV-355 an agent text entry of a turn shows its Markdown after the mark, and the result line of the turn stays plain", () => {
  const html = terminal(
    entry(1, { kind: "assistant", text: "**Done.** All `tests` pass." }),
    entry(2, { kind: "result", text: "Turn end: **success**" }),
  );
  assert.ok(
    html.includes(
      '<div class="entry assistant"><span class="mark">⏺</span><div class="markdown"><p><strong>Done.</strong> All <code>tests</code> pass.</p></div></div>',
    ),
    html,
  );
  assert.ok(html.includes("<pre>Turn end: **success**</pre>"), html);
});

await test("CLV-355 the README describes the height limit, the Markdown of agent text, the fold count at the end of the call line and the safe links", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const sentence of [
    "The lines of an open turn take at most 500 pixels of height, with their own scroll bar. A short turn takes only the height of its lines. The expand button `⤢` at the right end of the head of the turn shows all its lines in the page, and the collapse button `⤡` returns to 500 pixels. The full-screen view has no limit and no expand button.",
    "The view shows `⏺` and the text with its Markdown: bold, italic and code text, headings, lists, fenced code and links. A run of blank lines shows as one gap.",
    "The view folds it to one dim count at the end of the line of its call: `⎿` and the count of lines, for example `⎿ 42 lines`.",
    "The view never renders HTML from a transcript: HTML in a text shows as text. A link opens in a new tab only when its address starts with `http://` or `https://`; another link shows as text.",
  ])
    assert.ok(readme.includes(sentence), sentence);
  assert.ok(
    !readme.includes("It never renders HTML or Markdown from a transcript."),
  );
});
