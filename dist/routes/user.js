"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const data_source_1 = require("../data-source");
const user_1 = require("../entity/user");
require("@fastify/jwt");
async function userRoutes(fastify) {
    fastify.decorate("authenticate", async function (request, reply) {
        try {
            await request.jwtVerify();
        }
        catch (err) {
            reply.code(401).send(err);
        }
    });
    fastify.get("/", { preHandler: [fastify.authenticate] }, async (request, reply) => {
        const userRepository = data_source_1.AppDataSource.getRepository(user_1.User);
        const users = await userRepository.find();
        return reply.send(users);
    });
    // Add other CRUD operations here
}
exports.default = userRoutes;
//# sourceMappingURL=user.js.map