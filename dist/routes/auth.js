"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcrypt_1 = __importDefault(require("bcrypt"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const data_source_1 = require("../data-source");
const user_1 = require("../entity/user");
async function authRoutes(fastify) {
    fastify.register(jwt_1.default, {
        secret: process.env.JWT_SECRET || "supersecret",
    });
    fastify.post("/register", async (request, reply) => {
        const { email, password } = request.body;
        const userRepository = data_source_1.AppDataSource.getRepository(user_1.User);
        const existingUser = await userRepository.findOne({ where: { email } });
        if (existingUser) {
            return reply.status(400).send({ message: "User already exists" });
        }
        const hashedPassword = await bcrypt_1.default.hash(password, 10);
        const user = userRepository.create({
            email,
            passwordHash: hashedPassword,
        });
        await userRepository.save(user);
        return reply.send({ message: "User registered successfully" });
    });
    fastify.post("/login", async (request, reply) => {
        const { email, password } = request.body;
        const userRepository = data_source_1.AppDataSource.getRepository(user_1.User);
        const user = await userRepository.findOne({ where: { email } });
        if (!user) {
            return reply.status(401).send({ message: "Invalid credentials" });
        }
        const validPassword = await bcrypt_1.default.compare(password, user.passwordHash);
        if (!validPassword) {
            return reply.status(401).send({ message: "Invalid credentials" });
        }
        const token = fastify.jwt.sign({ id: user.id });
        return reply.send({ token });
    });
}
exports.default = authRoutes;
//# sourceMappingURL=auth.js.map