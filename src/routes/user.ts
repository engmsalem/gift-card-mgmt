import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppDataSource } from "../data-source";
import { User } from "../entity/user";
import "@fastify/jwt";
import { JWT } from "@fastify/jwt";

declare module "fastify" {
  /* interface FastifyRequest {
    jwtVerify: JWT["verify"];
  } */
  interface FastifyRequest {
    myPluginProp: string;
  }
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

export default async function userRoutes(fastify: FastifyInstance) {
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
      const userRepository = AppDataSource.getRepository(User);
      const users = await userRepository.find();
      return reply.send(users);
    }
  );

  // Add other CRUD operations here
}
