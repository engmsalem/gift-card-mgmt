import { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { User } from "../entities/user";
import { Role } from '../enums/roles';


export class AuthService {
  private userRepository;

  constructor(private app: FastifyInstance) {
    // Access the User repository using the Fastify instance
    this.userRepository = app.db.getRepository(User);
  }

  /**
   * Handles user login by validating credentials and returning a JWT.
   */
  async login(email: string, password: string) {
    // Find user by email
    const user = await this.userRepository.findOneBy({ email });
    if (!user) {
      throw new Error("Invalid email or password");
    }

    // Validate password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new Error("Invalid email or password");
    }

    // Generate access and refresh tokens
    const accessToken = this.app.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: "1h" } // Access token expiration
    );

    const refreshToken = this.app.jwt.sign(
      { id: user.id },
      { expiresIn: "7d" } // Refresh token expiration
    );

    return { accessToken, refreshToken };
  }

  /**
   * Handles token refresh to issue a new access token.
   */
  async refreshToken(refreshToken: string) {
    try {
      // Verify the refresh token
      const decoded = this.app.jwt.verify<{ id: number }>(refreshToken);

      // Generate a new access token
      const newAccessToken = this.app.jwt.sign(
        { id: decoded.id },
        { expiresIn: "1h" }
      );

      return newAccessToken;
    } catch (err) {
      throw new Error("Invalid or expired refresh token");
    }
  }

  /**
   * Handles user logout by invalidating refresh tokens.
   * This depends on your strategy (e.g., token revocation list, database cleanup).
   */
  async logout(refreshToken: string) {
    // Example implementation: track invalid tokens (optional)
    // In a real-world app, you might store invalidated tokens in a database or cache.

    // For simplicity, we assume the logout is successful
    return true;
  }

  /**
   * Handles user registration.
   */
  async register(name: string, email: string, password: string) {
    // Check if the email is already registered
    const existingUser = await this.userRepository.findOneBy({ email });
    if (existingUser) {
      throw new Error("User with this email already exists");
    }

    // Hash the password before storing
    const hashedPassword = await bcrypt.hash(password, 10);

   

