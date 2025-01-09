"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const fastify_1 = __importDefault(require("fastify"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const data_source_1 = require("./data-source");
// Initialize TypeORM before setting up Fastify
data_source_1.AppDataSource.initialize()
    .then(() => {
    console.log("Database connected");
    const app = (0, fastify_1.default)();
    app.register(jwt_1.default, {
        secret: "your-secret-key",
    });
    app.get("/", async (request, reply) => {
        return { hello: "world" };
    });
    app.listen({ port: 3000 }, (err, address) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`Server listening at ${address}`);
    });
})
    .catch((error) => console.log(error));
//# sourceMappingURL=index.js.map