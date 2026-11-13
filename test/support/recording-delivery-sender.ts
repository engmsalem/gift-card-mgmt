import type { GiftCardDeliveryMessage, GiftCardDeliverySender } from "../../src/services/deliveryDispatcher";

export type SenderBehavior = "send" | "throw" | "hang";

/**
 * Test double for the delivery port. Records every message it is given (including the link, which
 * the tests parse the token from), and can be told to fail or to never settle.
 *
 * - `send`: records and resolves.
 * - `throw`: records, then rejects with `failure` (default: a `SenderDownError`).
 * - `hang`: records, then returns a promise that never settles and ignores the abort signal.
 *
 * `onSend` runs after recording and before the behavior applies, for tests that must act while the
 * dispatcher is in the middle of a send (void or resend during `sending`).
 */
export class RecordingDeliverySender implements GiftCardDeliverySender {
  readonly messages: GiftCardDeliveryMessage[] = [];
  behavior: SenderBehavior;
  failure: Error = new SenderDownError("provider down");
  onSend?: (message: GiftCardDeliveryMessage) => Promise<void>;

  constructor(behavior: SenderBehavior = "send") {
    this.behavior = behavior;
  }

  async send(message: GiftCardDeliveryMessage): Promise<void> {
    this.messages.push(message);
    if (this.onSend) await this.onSend(message);
    if (this.behavior === "throw") throw this.failure;
    if (this.behavior === "hang") await new Promise<void>(() => undefined);
  }

  /** The raw token in the most recent message's link. */
  lastToken(): string {
    const message = this.messages[this.messages.length - 1];
    if (!message) throw new Error("nothing was sent");
    return tokenOf(message.link);
  }
}

export class SenderDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderDownError";
  }
}

/** The token in a link's `#token=` fragment. */
export function tokenOf(link: string): string {
  const marker = "#token=";
  const at = link.indexOf(marker);
  if (at < 0) throw new Error("link has no token fragment");
  return link.slice(at + marker.length);
}
