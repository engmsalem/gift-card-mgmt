import { FastifyInstance } from "fastify";
import type { CardCrypto } from "../gift-cards/card-crypto";
import type { DeliveryDispatcher } from "../services/deliveryDispatcher";
import { DeliveryService } from "../services/deliveryService";
import { errorResponse, giftCardRevealResponse } from "./schemas";

export interface GiftCardLinkRoutesOptions {
  cardCrypto: CardCrypto;
  dispatcher: DeliveryDispatcher;
}

export default async function giftCardLinkRoutes(fastify: FastifyInstance, opts: GiftCardLinkRoutesOptions) {
  const deliveries = new DeliveryService(fastify, opts.cardCrypto, opts.dispatcher);

  // Public: the token in the body is the credential. Limited per IP (the global default key).
  fastify.post<{ Body: { token: string } }>(
    "/gift-card-links/reveal",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["token"],
          additionalProperties: false,
          properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
        },
        response: { 200: giftCardRevealResponse, "4xx": errorResponse },
      },
    },
    async (request, reply) => {
      // Set first so the 404 is not cached either
      void reply.header("Cache-Control", "no-store");
      return deliveries.reveal(request.body.token);
    }
  );
}
