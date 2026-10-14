import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AccessTokenPayload {
  sub: string;
  role: string;
  email: string;
  displayName: string;
}

export const signAccessToken = (payload: AccessTokenPayload) => {
  return jwt.sign(payload, env.jwtSecret as any, { expiresIn: env.jwtExpiresIn as any });
};

export const verifyAccessToken = (token: string) => {
  return jwt.verify(token, env.jwtSecret as any) as AccessTokenPayload;
};
