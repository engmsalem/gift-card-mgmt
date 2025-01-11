import { FastifyInstance } from "fastify";
import { DataSource } from "typeorm";
import { User } from "../entities/user";

export class UserService {
  //commented to use testify decorator approach
  // constructor(private dataSource: DataSource) {}
  private userRepository;
  constructor(private app: FastifyInstance) {
    // Access the User repository using the Fastify instance
    this.userRepository = app.db.getRepository(User);
  }

  async createUser(name: string, email: string) {
    // Validate business logic
    const existingUser = await this.userRepository.findOneBy({ email });
    if (existingUser) {
      throw new Error("User with this email already exists");
    }

    // Save the new user
    const newUser = this.userRepository.create({ email });
    return this.userRepository.save(newUser);
  }
}
