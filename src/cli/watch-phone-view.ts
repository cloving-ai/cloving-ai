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

export interface PhoneControls {
  readonly pairing: PhonePairing | null;
  readonly busy: boolean;
  readonly message: string;
  readonly onPair: () => void;
  readonly onCancel: () => void;
}

export function timeLeft(expiresAt: string, now: string): string {
  const seconds = Math.max(
    0,
    Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / 1000),
  );
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")} left`;
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

export function PhonePanel(props: {
  readonly phone: PhoneControls;
  readonly now: string;
}): Shown {
  const { phone, now } = props;
  const message =
    phone.message === ""
      ? null
      : element("p", { class: "bad", role: "status", children: phone.message });
  if (phone.pairing === null)
    return element("section", {
      class: "phone",
      children: [
        element("button", {
          type: "button",
          disabled: phone.busy,
          onClick: phone.onPair,
          children: "Connect a phone",
        }),
        message,
      ],
    });
  return element("section", {
    class: "phone phone-pairing",
    children: [
      component(PhoneCode, { picture: phone.pairing.picture }),
      element("div", {
        children: [
          element("strong", { children: "Scan with your phone camera" }),
          element("span", { children: timeLeft(phone.pairing.expiresAt, now) }),
          element("button", {
            type: "button",
            onClick: phone.onCancel,
            children: "Cancel",
          }),
        ],
      }),
      message,
    ],
  });
}
