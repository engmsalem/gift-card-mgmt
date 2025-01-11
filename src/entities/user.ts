import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";
import { Role } from "../enums/roles";
import { IsEmail, MinLength } from "class-validator";
import ExtendedBaseEntity from "./extended-base-entity";

@Entity()
export class User extends ExtendedBaseEntity {
  @PrimaryColumn()
  id: number;

  @Column()
  tenantId: number;

  @Column()
  name: string;

  @Column({ unique: true })
  @IsEmail()
  email: string;

  @Column()
  @MinLength(6)
  passwordHash: string;

  @Column()
  role: Role;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
