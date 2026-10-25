import assert from "node:assert/strict";
import { test } from "node:test";
import { PhonePanel, timeLeft } from "../src/cli/watch-phone-view.ts";
import { rendered } from "./watch-dom.ts";

const controls = {
  busy: false,
  message: "",
  onPair: () => undefined,
  onCancel: () => undefined,
};

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

await test("CLV-188 the phone panel shows the button, the code with its time, and a message", () => {
  const now = "2026-10-25T12:00:00.000Z";
  assert.equal(
    text(rendered(PhonePanel({ phone: { ...controls, pairing: null }, now }))),
    "Connect a phone",
  );
  const shown = text(
    rendered(
      PhonePanel({
        phone: {
          ...controls,
          message: "The watch tool does not answer.",
          pairing: {
            link: "https://cloving.ai/pair#v1.x",
            expiresAt: "2026-10-25T12:09:05.000Z",
            picture: { size: 29, path: "M4 4h1v1h-1z" },
          },
        },
        now,
      }),
    ),
  );
  assert.equal(
    shown,
    "Scan with your phone camera 9:05 left Cancel The watch tool does not answer.",
  );
  assert.equal(timeLeft("2026-10-25T11:00:00.000Z", now), "0:00 left");
});
