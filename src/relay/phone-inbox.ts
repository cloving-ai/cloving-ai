import { Actor } from "solid-objects";
import type { PostedEnvelope } from "./phone-delivery.ts";

export type InboxWork = {
  readonly answerId: string;
  readonly sequence: number;
  readonly deviceId: string;
  readonly envelope: PostedEnvelope | null;
};

export class PhoneInbox extends Actor {
  static override readonly actorType = "PhoneInbox";

  cursor = 0;

  work: InboxWork[] = [];

  record(work: InboxWork): InboxWork {
    const known = this.work.find((item) => item.answerId === work.answerId);
    if (known !== undefined) return known;
    this.work = [...this.work, work];
    return work;
  }

  complete({
    answerId,
    sequence,
  }: {
    readonly answerId: string;
    readonly sequence: number;
  }): void {
    this.work = this.work.filter((item) => item.answerId !== answerId);
    this.cursor = Math.max(this.cursor, sequence);
  }
}
