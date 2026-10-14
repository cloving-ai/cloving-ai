import assert from "node:assert/strict";
import { test } from "node:test";
import { component, element, type Shown } from "../src/cli/watch-element.ts";
import { found, rendered } from "./watch-dom.ts";

function Greeting(props: { readonly name: string }): Shown {
  return element("b", { title: props.name, children: props.name });
}

await test("CLV-016 an element of the watch page is a tag with its properties, and a component gives its content only on demand, with its typed properties", () => {
  assert.deepEqual(element("p", { class: "meta", children: "a" }), {
    tag: "p",
    props: { class: "meta", children: "a" },
  });
  const calls: string[] = [];
  const counted = (props: { readonly name: string }): Shown => {
    calls.push(props.name);
    return component(Greeting, props);
  };
  const view = component(counted, { name: "<Ada>", key: "k1" });
  assert.deepEqual(calls, []);
  assert.equal(rendered(view), '<b title="&lt;Ada&gt;">&lt;Ada&gt;</b>');
  assert.deepEqual(calls, ["<Ada>"]);
});

await test("CLV-016 the static view of the watch tests shows text as text, omits empty values and event handlers, and finds the elements of one tag", () => {
  const view = element("section", {
    class: 'a "b"',
    open: true,
    hidden: false,
    title: undefined,
    onClick: (): void => undefined,
    key: "k",
    children: [
      "x & y",
      5,
      null,
      false,
      undefined,
      true,
      [element("br", {}), component(Greeting, { name: "n" })],
    ],
  });
  assert.equal(
    rendered(view),
    '<section class="a &quot;b&quot;" open>x &amp; y5<br><b title="n">n</b></section>',
  );
  assert.deepEqual(found(view, "b"), [{ title: "n", children: "n" }]);
  assert.deepEqual(found(view, "i"), []);
});
