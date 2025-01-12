import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UserService } from "../services/userService";
import { AppDataSource } from "../data-source";
import { User } from "../entities/user";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>; // Add the type for your custom method
  }
}

export default async function userRoutes(fastify: FastifyInstance) {
  const userService = new UserService(fastify);

  fastify.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.code(401).send(err);
      }
    }
  );

  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const users = await userService.getAllUsers();
        return reply.send(users);
      } catch (error) {
        return reply.status(500).send({ error: error.message });
      }
    }
  );

  // Add other CRUD operations here, using userService methods
}
