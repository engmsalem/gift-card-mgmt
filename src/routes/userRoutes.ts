import { FastifyInstance } from "fastify";
import { Role } from "../enums/roles";
import { requireRole } from "../plugins/jwt";
import { CreateUserInput, UserService } from "../services/userService";
import { errorResponse, userResponse } from "./schemas";

export default async function userRoutes(fastify: FastifyInstance) {
  const userService = new UserService(fastify);
  const adminOnly = [fastify.authenticate, requireRole(Role.ADMIN)];

  // Invite a user into the caller's own tenant
  fastify.post<{ Body: CreateUserInput }>(
    "/users",
    {
      preHandler: adminOnly,
      schema: {
        body: {
          type: "object",
          required: ["name", "email", "password"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            email: { type: "string", maxLength: 254 },
            password: { type: "string", minLength: 8, maxLength: 72 },
            role: { type: "string", enum: Object.values(Role) },
          },
        },
        response: { 201: userResponse, "4xx": errorResponse },
      },
    },
    async (request, reply) => {
      const user = await userService.createUser(request.user.tenantId, request.body);
      return reply.status(201).send(user);
    }
  );

  fastify.get(
    "/users",
    {
      preHandler: adminOnly,
      schema: { response: { 200: { type: "array", items: userResponse }, "4xx": errorResponse } },
    },
    async (request) => userService.listUsers(request.user.tenantId)
  );

  fastify.get(
    "/users/me",
    {
      preHandler: [fastify.authenticate],
      schema: { response: { 200: userResponse, "4xx": errorResponse } },
    },
    async (request) => userService.getUser(request.user.tenantId, request.user.id)
  );
}
