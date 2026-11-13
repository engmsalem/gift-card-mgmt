import type { GiftCardDeliveryMessage, GiftCardDeliverySender } from "../services/deliveryDispatcher";

/**
 * Development only (config allows GIFT_CARD_DEV_PRINT_LINKS=true only when NODE_ENV=development):
 * prints the recipient and the reveal link so a developer can open it by hand. It writes with
 * `console.log`, not the application logger, so log redaction is not involved; the link carries
 * the raw token, which is why this sender must never run outside development.
 */
export class ConsoleLinkDeliverySender implements GiftCardDeliverySender {
  send(message: GiftCardDeliveryMessage): Promise<void> {
    console.log(JSON.stringify({ deliveryId: message.deliveryId, to: message.to, link: message.link }));
    return Promise.resolve();
  }
}
