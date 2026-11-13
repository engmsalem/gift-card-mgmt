import { ConfigError } from "../config";
import type { DispatcherLog, GiftCardDeliverySender } from "../services/deliveryDispatcher";
import { ConsoleLinkDeliverySender } from "./console-link-sender";
import { LogOnlyDeliverySender } from "./log-only-sender";

export interface SenderSelectionInput {
  /** Replaces the configured sender (tests inject a recording one); never set in production. */
  override?: GiftCardDeliverySender;
  nodeEnv: string;
  /** Development only: config allows it solely under NODE_ENV=development. */
  devPrintLinks: boolean;
  log: Pick<DispatcherLog, "info">;
}

/**
 * The one place that picks the delivery sender, shared by the API and the dispatch script: the
 * override, else the development console sender, else (outside production) the log-only sender.
 * There is no email provider yet, and the log-only sender reports success while sending nothing,
 * so in production there is nothing safe to pick and it refuses.
 */
export function selectDeliverySender(input: SenderSelectionInput): GiftCardDeliverySender {
  if (input.override) return input.override;
  if (input.devPrintLinks) return new ConsoleLinkDeliverySender();
  if (input.nodeEnv === "production") {
    throw new ConfigError(
      "Gift card email delivery has no provider configured: in production the log-only sender would mark gift card emails as sent without delivering them, and the recipient's link would be lost. Configure an email provider before running in production."
    );
  }
  return new LogOnlyDeliverySender(input.log);
}
