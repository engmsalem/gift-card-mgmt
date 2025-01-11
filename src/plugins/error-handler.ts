import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export default fp(async function (fastify: FastifyInstance) {
  fastify.setErrorHandler(
    (error, request: FastifyRequest, reply: FastifyReply) => {
      fastify.log.error(error);
      reply.status(500).send({ error: "Internal Server Error" });
    }
  );
});
