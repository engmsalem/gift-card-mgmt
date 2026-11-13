import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Role } from "../enums/roles";
import type { CardCrypto } from "../gift-cards/card-crypto";
import { requireRole } from "../plugins/jwt";
import type { DeliveryDispatcher } from "../services/deliveryDispatcher";
import { DeliveryService, ResendInput } from "../services/deliveryService";
import { CardWithDelivery, GiftCardService, IssueInput } from "../services/giftCardService";
import {
  CardAuthFailedError,
  LookupInput,
  RedemptionService,
  RedeemInput,
  RefundInput,
  TransactionResult,
} from "../services/redemptionService";
import {
  NO_CONTROL_CHARS,
  errorResponse,
  giftCardDeliveryOnlyResponse,
  giftCardLookupResponse,
  giftCardTransactionResponse,
  giftCardTransactionResultResponse,
  giftCardWithDeliveryResponse,
  idParams,
} from "./schemas";

export interface GiftCardRoutesOptions {
  cardCrypto: CardCrypto;
  dispatcher: DeliveryDispatcher;
  lockTimeoutMs: number;
}

// Shape only (B-3): the business rules (program state, amount cap, staff limit) live in
// src/gift-cards/card-state.ts and are applied by the service.
// A message may span lines (LF, CR) but holds no other control characters
const MESSAGE_PATTERN = "^[^\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]*$";
const MAX_INT32 = 2147483647;
const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9_-]{16,64}$";
const CARD_NUMBER_PATTERN = "^[0-9][0-9 -]{14,26}[0-9]$";
const PIN_PATTERN = "^[0-9]{6}$";

const name = { type: "string", minLength: 1, maxLength: 100, pattern: NO_CONTROL_CHARS } as const;

/** `max` requests per minute per signed-in user (the hook runs after `authenticate`, so request.user is set). */
function perUser(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: (request: FastifyRequest) => "user:" + request.user.id,
    },
  };
}

export default async function giftCardRoutes(fastify: FastifyInstance, opts: GiftCardRoutesOptions) {
  const service = new GiftCardService(fastify, opts.cardCrypto, opts.dispatcher);
  const deliveries = new DeliveryService(fastify, opts.cardCrypto, opts.dispatcher);
  const redemptions = new RedemptionService(fastify, opts.cardCrypto, opts.lockTimeoutMs);
  const adminOnly = [fastify.authenticate, requireRole(Role.ADMIN)];
  const adminOrStaffHooks = () => [fastify.authenticate, requireRole(Role.ADMIN, Role.STAFF)];
  const adminOrStaff = adminOrStaffHooks();
  // @fastify/rate-limit pushes a route's limiter hook onto that route's own onRequest array. A route
  // with its own limit must therefore get a fresh array (adminOrStaffHooks()): on the shared one its
  // limit would leak onto every route that uses it, and other routes' hooks would run first.
  const ctxOf = (request: FastifyRequest) => ({ tenantId: request.user.tenantId, userId: request.user.id });

  fastify.post<{ Body: IssueInput }>(
    "/gift-cards",
    {
      onRequest: adminOrStaffHooks(),
      config: perUser(60),
      schema: {
        body: {
          type: "object",
          required: ["programId", "amount", "idempotencyKey", "recipient", "senderName"],
          additionalProperties: false,
          properties: {
            programId: { type: "string", format: "uuid" },
            amount: { type: "integer", minimum: 1, maximum: MAX_INT32 },
            idempotencyKey: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN },
            recipient: {
              type: "object",
              required: ["name", "email"],
              additionalProperties: false,
              properties: { name, email: { type: "string", minLength: 3, maxLength: 254 } },
            },
            senderName: name,
            message: { type: "string", maxLength: 500, pattern: MESSAGE_PATTERN },
            sendAt: { type: "string", format: "date-time" },
          },
        },
        response: { 200: giftCardWithDeliveryResponse, 201: giftCardWithDeliveryResponse, "4xx": errorResponse },
      },
    },
    async (request, reply) => {
      const { replayed, card, delivery } = await service.issue(
        { ...ctxOf(request), role: request.user.role },
        request.body
      );
      if (replayed) return reply.status(200).header("Idempotent-Replayed", "true").send({ card, delivery });
      return reply.status(201).send({ card, delivery });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    "/gift-cards/:id",
    {
      onRequest: adminOrStaff,
      schema: { params: idParams, response: { 200: giftCardWithDeliveryResponse, "4xx": errorResponse } },
    },
    async (request) => service.getCard(request.user.tenantId, request.params.id)
  );

  fastify.get<{ Params: { reference: string } }>(
    "/gift-cards/by-reference/:reference",
    {
      onRequest: adminOrStaff,
      schema: {
        params: {
          type: "object",
          required: ["reference"],
          properties: { reference: { type: "string", maxLength: 32 } },
        },
        response: { 200: giftCardWithDeliveryResponse, "4xx": errorResponse },
      },
    },
    async (request) => service.getCardByReference(request.user.tenantId, request.params.reference)
  );

  fastify.get<{ Params: { id: string } }>(
    "/gift-cards/:id/transactions",
    {
      onRequest: adminOrStaff,
      schema: {
        params: idParams,
        response: { 200: { type: "array", items: giftCardTransactionResponse }, "4xx": errorResponse },
      },
    },
    async (request) => service.listTransactions(request.user.tenantId, request.params.id)
  );

  // Card authentication failures are logged per actor (design 7.11): the signed-in user, the tenant and
  // the route, never the number, the PIN or the body. The response is the same 404 for every cause.
  const withAuthFailureLog = async <T>(request: FastifyRequest, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof CardAuthFailedError) {
        request.log.warn({
          userId: request.user.id,
          tenantId: request.user.tenantId,
          route: request.routeOptions.url,
          outcome: "card_auth_failed",
        });
      }
      throw err;
    }
  };

  const cardAuthProperties = {
    cardNumber: { type: "string", pattern: CARD_NUMBER_PATTERN },
    pin: { type: "string", pattern: PIN_PATTERN },
  } as const;

  fastify.post<{ Body: LookupInput }>(
    "/gift-cards/lookup",
    {
      onRequest: adminOrStaffHooks(),
      config: perUser(30),
      schema: {
        body: {
          type: "object",
          required: ["cardNumber"],
          additionalProperties: false,
          properties: cardAuthProperties,
        },
        response: { 200: giftCardLookupResponse, "4xx": errorResponse },
      },
    },
    async (request) => withAuthFailureLog(request, () => redemptions.lookup(ctxOf(request), request.body))
  );

  const sendTransactionResult = (reply: FastifyReply, { replayed, transaction, card }: TransactionResult) => {
    if (replayed) return reply.status(200).header("Idempotent-Replayed", "true").send({ transaction, card });
    return reply.status(201).send({ transaction, card });
  };

  fastify.post<{ Body: RedeemInput }>(
    "/gift-cards/redeem",
    {
      onRequest: adminOrStaffHooks(),
      config: perUser(30),
      schema: {
        body: {
          type: "object",
          required: ["cardNumber", "amount", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            ...cardAuthProperties,
            amount: { type: "integer", minimum: 1, maximum: MAX_INT32 },
            idempotencyKey: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN },
            externalReference: { type: "string", minLength: 1, maxLength: 64, pattern: NO_CONTROL_CHARS },
          },
        },
        response: { 200: giftCardTransactionResultResponse, 201: giftCardTransactionResultResponse, "4xx": errorResponse },
      },
    },
    async (request, reply) =>
      sendTransactionResult(
        reply,
        await withAuthFailureLog(request, () => redemptions.redeem(ctxOf(request), request.body))
      )
  );

  // Admin only; the amount is bounded by the redemption it refunds (checked in the service)
  fastify.post<{ Params: { id: string }; Body: RefundInput }>(
    "/gift-card-transactions/:id/refunds",
    {
      onRequest: adminOnly,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["amount", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            amount: { type: "integer", minimum: 1, maximum: MAX_INT32 },
            idempotencyKey: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN },
          },
        },
        response: { 200: giftCardTransactionResultResponse, 201: giftCardTransactionResultResponse, "4xx": errorResponse },
      },
    },
    async (request, reply) =>
      sendTransactionResult(reply, await redemptions.refund(ctxOf(request), request.params.id, request.body))
  );

  // Admin state changes. Repeating one that already holds (suspend a suspended card, ...) is a 200.
  const stateChange = (action: string, run: (ctx: ReturnType<typeof ctxOf>, id: string) => Promise<CardWithDelivery>) =>
    fastify.post<{ Params: { id: string } }>(
      `/gift-cards/:id/${action}`,
      {
        onRequest: adminOnly,
        schema: { params: idParams, response: { 200: giftCardWithDeliveryResponse, "4xx": errorResponse } },
      },
      async (request) => run(ctxOf(request), request.params.id)
    );
  stateChange("suspend", (ctx, id) => service.suspend(ctx, id));
  stateChange("resume", (ctx, id) => service.resume(ctx, id));
  stateChange("void", (ctx, id) => service.void(ctx, id));
  stateChange("unlock", (ctx, id) => service.unlock(ctx, id));

  // Staff may resend to the recipient on file; changing the recipient is checked in the service
  fastify.post<{ Params: { id: string }; Body: ResendInput | undefined }>(
    "/gift-cards/:id/resend",
    {
      onRequest: adminOrStaffHooks(),
      config: perUser(10),
      // A resend to the recipient on file needs no body: validate it as an empty object
      preValidation: async (request) => {
        request.body ??= {};
      },
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            recipient: {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: { name, email: { type: "string", minLength: 3, maxLength: 254 } },
            },
          },
        },
        response: { 200: giftCardDeliveryOnlyResponse, "4xx": errorResponse },
      },
    },
    async (request) => ({
      delivery: await deliveries.resend({ ...ctxOf(request), role: request.user.role }, request.params.id, request.body ?? {}),
    })
  );
}
