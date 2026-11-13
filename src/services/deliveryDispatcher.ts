export interface DispatchInput {
  deliveryId?: string;
  limit?: number;
}

/**
 * Placeholder until the delivery phase: issuing creates the delivery row and calls `dispatch`, which
 * does nothing yet, so a new delivery stays `scheduled`. The real dispatcher (claim, send under a
 * timeout, record the outcome) replaces this class and keeps the `dispatch` call site.
 */
export class DeliveryDispatcher {
  dispatch(input: DispatchInput): Promise<void> {
    void input;
    return Promise.resolve();
  }
}
