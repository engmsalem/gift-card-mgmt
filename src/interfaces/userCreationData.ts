// src/interfaces/userCreationData.ts
import { Role } from "../enums/roles";
export interface UserCreationData {
  email: string;
  passwordHash: string;
  role: Role;
  tenantId: number;
}
