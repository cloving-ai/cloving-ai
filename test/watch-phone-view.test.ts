import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PhonePanel,
  refusalText,
  timeLeft,
  type PhoneControls,
} from "../src/cli/watch-phone-view.ts";
import { found, rendered } from "./watch-dom.ts";

const controls: PhoneControls = {
  pairing: null,
  request: null,
  stage: null,
  connected: null,
  refusal: null,
  reason: null,
  devices: [],
  busy: false,
  message: "",
  onPair: () => undefined,
  onCancel: () => undefined,
  onAccept: () => undefined,
  onDeny: () => undefined,
  onRemove: () => undefined,
};

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
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

const now = "2026-10-25T12:00:00.000Z";
const request = {
  deviceId: "phone-1",
  name: "Pixel 8a",
  platform: "android",
  code: "482913",
};
const pairing = {
  link: "https://cloving.ai/pair#v1.x",
  expiresAt: "2026-10-25T12:09:05.000Z",
  picture: { size: 29, path: "M4 4h1v1h-1z" },
};

function shown(phone: Partial<PhoneControls>): string {
  return text(rendered(PhonePanel({ phone: { ...controls, ...phone }, now })));
}

await test("CLV-189 the phone panel asks about a request and lists the devices", () => {
  const devices = [
    {
      deviceId: "phone-1",
      name: "Pixel 8a",
      platform: "android",
      state: "connected",
      removedAt: null,
    },
    {
      deviceId: "phone-0",
      name: "Old",
      platform: "ios",
      state: "checking",
      removedAt: "2026-10-24T12:00:00Z",
    },
  ];
  assert.equal(
    shown({ pairing, request, stage: "requested", devices }),
    'Connect "Pixel 8a" (android)? Code 482913 Accept Deny Cancel Pixel 8a (android) connected Remove Old (ios) removed',
  );
});

await test("CLV-189 the phone panel shows checking, the result and the refusal texts", () => {
  assert.equal(
    shown({ pairing, request, stage: "checking" }),
    "Checking Pixel 8a Cancel",
  );
  assert.match(
    shown({ connected: "Pixel 8a", refusal: "pairing-check-invalid" }),
    /Connected: Pixel 8a The phone did not confirm the connection\./,
  );
  assert.equal(
    refusalText("other-code"),
    "The connection did not work (other-code).",
  );
  for (const code of [
    "pairing-mac-invalid",
    "pairing-key-invalid",
    "pairing-request-invalid",
    "pairing-device-revoked",
    "pairing-expired",
  ])
    assert.doesNotMatch(refusalText(code), /did not work/);
});

await test("CLV-189 the Remove button of a phone sends its device ID", () => {
  const removed: string[] = [];
  const panel = PhonePanel({
    phone: {
      ...controls,
      devices: [
        {
          deviceId: "phone-1",
          name: "Pixel 8a",
          platform: "android",
          state: "connected",
          removedAt: null,
        },
      ],
      onRemove: (deviceId) => {
        removed.push(deviceId);
      },
    },
    now,
  });
  const remove = found(panel, "button").find(
    (props) => props["children"] === "Remove",
  );
  const click = remove?.["onClick"];
  assert.ok(typeof click === "function");
  Reflect.apply(click, undefined, []);
  assert.deepEqual(removed, ["phone-1"]);
});

await test("CLV-190 the phone panel asks to connect the phones again after a lost registration", () => {
  assert.equal(
    shown({ reason: "registration-lost" }),
    "Connect a phone Connect your phones again.",
  );
});
