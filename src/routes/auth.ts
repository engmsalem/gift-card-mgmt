import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
    import bcrypt from 'bcrypt';
    import jwt from 'fastify-jwt';
    import { getRepository } from 'typeorm';
    import { User } from '../entity/User';

    export default async function authRoutes(fastify: FastifyInstance) {
      fastify.register(jwt, {
        secret: process.env.JWT_SECRET || 'supersecret'
      });

      fastify.post('/register', async (request: FastifyRequest, reply: FastifyReply) => {
        const { email, password } = request.body as any;
        const userRepository = getRepository(User);

        const existingUser = await userRepository.findOne({ where: { email } });
        if (existingUser) {
          return reply.status(400).send({ message: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = userRepository.create({
          email,
          password: hashedPassword
        });

        await userRepository.save(user);
        return reply.send({ message: 'User registered successfully' });
      });

      fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
        const { email, password } = request.body as any;
        const userRepository = getRepository(User);

        const user = await userRepository.findOne({ where: { email } });
        if (!user) {
          return reply.status(401).send({ message: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
          return reply.status(401).send({ message: 'Invalid credentials' });
        }

        const token = fastify.jwt.sign({ id: user.id });
        return reply.send({ token });
      });
    }
