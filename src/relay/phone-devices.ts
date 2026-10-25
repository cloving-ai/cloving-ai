import { Actor } from "solid-objects";

export type PhoneDevice = {
  readonly deviceId: string;
};

export class PhoneDevices extends Actor {
  static override readonly actorType = "PhoneDevices";

  devices: PhoneDevice[] = [];
}
