import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { FastifyInstance } from "fastify";

export default fp(async function (fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
});
