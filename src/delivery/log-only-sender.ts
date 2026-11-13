import type { DispatcherLog, GiftCardDeliveryMessage, GiftCardDeliverySender } from "../services/deliveryDispatcher";

/**
 * Records that a message would be sent, and nothing else: no link, token, address local part,
 * names or message text. A real email provider replaces it.
 */
export class LogOnlyDeliverySender implements GiftCardDeliverySender {
  constructor(private readonly log: Pick<DispatcherLog, "info">) {}

  send(message: GiftCardDeliveryMessage): Promise<void> {
    const at = message.to.email.lastIndexOf("@");
    this.log.info(
      { deliveryId: message.deliveryId, tenantId: message.tenantId, recipientDomain: message.to.email.slice(at + 1) },
      "gift card delivery (log-only sender, no email sent)"
    );
    return Promise.resolve();
  }
}
