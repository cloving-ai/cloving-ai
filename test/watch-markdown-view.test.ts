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

await test("CLV-355 a numbered list that starts at 3 keeps its start, and a nested item keeps its depth", () => {
  assert.equal(
    markdown("3. third\n4. fourth\n   - inner"),
    '<div class="markdown"><ol start="3"><li>third</li><li>fourth</li></ol><ul><li class="md-nested">inner</li></ul></div>',
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
    "The lines of an open turn take at most 60 percent of the height of the window, with their own scroll bar. A short turn takes only the height of its lines.",
    "The view shows `⏺` and the text with its Markdown: bold, italic and code text, headings, lists, fenced code and links. A run of blank lines shows as one gap.",
    "The view folds it to one dim count at the end of the line of its call: `⎿` and the count of lines, for example `⎿ 42 lines`.",
    "The view never renders HTML from a transcript: HTML in a text shows as text. A link opens in a new tab only when its address starts with `http://` or `https://`; another link shows as text.",
  ])
    assert.ok(readme.includes(sentence), sentence);
  assert.ok(
    !readme.includes("It never renders HTML or Markdown from a transcript."),
  );
});
