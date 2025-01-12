import { FastifyInstance } from "fastify";
import { UserRepository } from "../repositories/userRepository";
import { User } from "../entities/user";
import { UserCreationData } from "../interfaces/userCreationData"; // Import the interface

export class UserService {
  //commented to use testify decorator approach
  // constructor(private dataSource: DataSource) {}
  private userRepository: UserRepository;
  constructor(private app: FastifyInstance) {
    // Access the User repository using the Fastify instance
    this.userRepository = new UserRepository(app.db.getRepository(User));
  }

  async createUser(userData: UserCreationData) {
    // Validate business logic
    const existingUser = await this.userRepository.findByEmail(userData.email);
    if (existingUser) {
      throw new Error("User with this email already exists");
    }

    // Save the new user
    return this.userRepository.createUser(
      userData.email,
      userData.passwordHash,
      userData.role,
      userData.tenantId
    );
  }
  // Method to get all users
  async getAllUsers(): Promise<User[]> {
    // Call repository to fetch users
    const users = await this.userRepository.getAllUsers();

    // Apply business logic (if any)
    // Example: Filter users, add metadata, etc.

    return users;
  }
}
