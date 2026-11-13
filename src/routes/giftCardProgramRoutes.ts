import { FastifyInstance } from "fastify";
import { Role } from "../enums/roles";
import { requireRole } from "../plugins/jwt";
import {
  CreateProgramInput,
  GiftCardProgramService,
  UpdateProgramInput,
} from "../services/giftCardProgramService";
import { errorResponse, giftCardProgramResponse } from "./schemas";

// Shape only (B-3): the business rules (supported currency, prefix, expiry, ...) live in
// src/gift-cards/program-rules.ts and are applied by the service.
const NO_CONTROL_CHARS = "^[^\u0000-\u001f\u007f]+$";

const programFields = {
  name: { type: "string", minLength: 1, maxLength: 100, pattern: NO_CONTROL_CHARS },
  cardType: { type: "string", enum: ["paid", "promotional"] },
  currency: { type: "string", minLength: 3, maxLength: 3 },
  country: { type: "string", minLength: 2, maxLength: 2 },
  cardNumberPrefix: { type: "string", minLength: 1, maxLength: 6 },
  cardNumberLength: { type: "integer" },
  pinRequired: { type: "boolean" },
  maxValue: { type: "integer" },
} as const;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export default async function giftCardProgramRoutes(fastify: FastifyInstance) {
  const programService = new GiftCardProgramService(fastify);
  const adminOnly = [fastify.authenticate, requireRole(Role.ADMIN)];
  const adminOrStaff = [fastify.authenticate, requireRole(Role.ADMIN, Role.STAFF)];

  fastify.post<{ Body: CreateProgramInput }>(
    "/gift-card-programs",
    {
      onRequest: adminOnly,
      schema: {
        body: {
          type: "object",
          required: [
            "name",
            "cardType",
            "currency",
            "country",
            "cardNumberPrefix",
            "cardNumberLength",
            "pinRequired",
            "maxValue",
          ],
          additionalProperties: false,
          properties: {
            ...programFields,
            region: { type: "string", maxLength: 6 },
            expiryMonths: { type: "integer" },
            staffDailyIssueLimit: { type: "integer" },
          },
        },
        response: { 201: giftCardProgramResponse, "4xx": errorResponse },
      },
    },
    async (request, reply) => {
      const program = await programService.createProgram(
        { tenantId: request.user.tenantId, userId: request.user.id },
        request.body
      );
      return reply.status(201).send(program);
    }
  );

  fastify.get(
    "/gift-card-programs",
    {
      onRequest: adminOrStaff,
      schema: { response: { 200: { type: "array", items: giftCardProgramResponse }, "4xx": errorResponse } },
    },
    async (request) => programService.listPrograms(request.user.tenantId)
  );

  fastify.get<{ Params: { id: string } }>(
    "/gift-card-programs/:id",
    {
      onRequest: adminOrStaff,
      schema: { params: idParams, response: { 200: giftCardProgramResponse, "4xx": errorResponse } },
    },
    async (request) => programService.getProgram(request.user.tenantId, request.params.id)
  );

  // A non-empty subset of the program fields. Immutable ones are accepted here and answered with
  // 409 by the service once a card exists; expiryMonths, region and staffDailyIssueLimit may be null.
  fastify.patch<{ Params: { id: string }; Body: UpdateProgramInput }>(
    "/gift-card-programs/:id",
    {
      onRequest: adminOnly,
      schema: {
        params: idParams,
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            ...programFields,
            region: { type: ["string", "null"], maxLength: 6 },
            expiryMonths: { type: ["integer", "null"] },
            staffDailyIssueLimit: { type: ["integer", "null"] },
            status: { type: "string", enum: ["active", "retired"] },
          },
        },
        response: { 200: giftCardProgramResponse, "4xx": errorResponse },
      },
    },
    async (request) =>
      programService.updateProgram(
        { tenantId: request.user.tenantId, userId: request.user.id },
        request.params.id,
        request.body
      )
  );
}
