import { component, element, type Shown } from "./watch-element.ts";

export interface PhonePicture {
  readonly size: number;
  readonly path: string;
}

export interface PhonePairing {
  readonly link: string;
  readonly expiresAt: string;
  readonly picture: PhonePicture;
}

export interface PhoneRequest {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly code: string;
}

export interface PhoneDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly state: string;
  readonly removedAt: string | null;
}

export interface PhoneControls {
  readonly pairing: PhonePairing | null;
  readonly request: PhoneRequest | null;
  readonly stage: string | null;
  readonly connected: string | null;
  readonly refusal: string | null;
  readonly reason: string | null;
  readonly devices: readonly PhoneDevice[];
  readonly busy: boolean;
  readonly message: string;
  readonly onPair: () => void;
  readonly onCancel: () => void;
  readonly onAccept: () => void;
  readonly onDeny: () => void;
  readonly onRemove: (deviceId: string) => void;
}

export function timeLeft(expiresAt: string, now: string): string {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / 1000),
  );
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")} left`;
}

export function refusalText(code: string): string {
  const texts: Readonly<Record<string, string>> = {
    "pairing-mac-invalid":
      "The phone sent a request that does not agree with the QR code.",
    "pairing-key-invalid": "The phone sent a key that is not valid.",
    "pairing-request-invalid": "The phone sent a request that is not valid.",
    "pairing-device-revoked":
      "This phone was removed. Connect it again as a new phone.",
    "pairing-expired":
      "The connection request expired. Click Connect a phone again.",
    "pairing-check-invalid":
      "The phone did not confirm the connection. Remove it and connect again.",
  };
  return texts[code] ?? `The connection did not work (${code}).`;
}

export function PhoneCode(props: { readonly picture: PhonePicture }): Shown {
  const { size, path } = props.picture;
  return element("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    class: "phone-qr",
    viewBox: `0 0 ${String(size)} ${String(size)}`,
    role: "img",
    "aria-label": "Pairing QR code",
    "shape-rendering": "crispEdges",
    children: [
      element("rect", { width: size, height: size, fill: "#ffffff" }),
      element("path", { d: path, fill: "#000000" }),
    ],
  });
}

export function phoneButton(label: string, onClick: () => void): Shown {
  return element("button", { type: "button", onClick, children: label });
}

export function PhoneAsk(props: { readonly phone: PhoneControls }): Shown {
  const { phone } = props;
  const request = phone.request;
  if (request === null) return null;
  if (phone.stage === "checking")
    return element("p", { children: `Checking ${request.name}` });
  return element("div", {
    class: "phone-ask",
    children: [
      element("strong", {
        children: `Connect "${request.name}" (${request.platform})? Code ${request.code}`,
      }),
      phoneButton("Accept", phone.onAccept),
      phoneButton("Deny", phone.onDeny),
    ],
  });
}

export function PhoneList(props: { readonly phone: PhoneControls }): Shown {
  const { phone } = props;
  if (phone.devices.length === 0) return null;
  return element("ul", {
    class: "phone-list",
    children: phone.devices.map((device) =>
      element("li", {
        key: device.deviceId,
        children: [
          `${device.name} (${device.platform}) ${device.removedAt === null ? device.state : "removed"}`,
          device.removedAt === null
            ? phoneButton("Remove", () => {
                phone.onRemove(device.deviceId);
              })
            : null,
        ],
      }),
    ),
  });
}

export function phoneNotices(phone: PhoneControls): Shown {
  const lines = [
    phone.reason === "registration-lost" ? "Connect your phones again." : null,
    phone.connected === null ? null : `Connected: ${phone.connected}`,
    phone.refusal === null ? null : refusalText(phone.refusal),
    phone.message === "" ? null : phone.message,
  ];
  return lines.map((line) =>
    line === null ? null : element("p", { role: "status", children: line }),
  );
}

export function PhonePanel(props: {
  readonly phone: PhoneControls;
  readonly now: string;
}): Shown {
  const { phone, now } = props;
  const waiting = phone.request === null ? phone.pairing : null;
  return element("section", {
    class: waiting === null ? "phone" : "phone phone-pairing",
    children: [
      waiting === null
        ? null
        : component(PhoneCode, { picture: waiting.picture }),
      element("div", {
        children: [
          waiting === null
            ? null
            : [
                element("strong", { children: "Scan with your phone camera" }),
                element("span", { children: timeLeft(waiting.expiresAt, now) }),
              ],
          component(PhoneAsk, { phone }),
          phone.pairing === null
            ? element("button", {
                type: "button",
                disabled: phone.busy,
                onClick: phone.onPair,
                children: "Connect a phone",
              })
            : phoneButton("Cancel", phone.onCancel),
          phoneNotices(phone),
        ],
      }),
      component(PhoneList, { phone }),
    ],
  });
}
