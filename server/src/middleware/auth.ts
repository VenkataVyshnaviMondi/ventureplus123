import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { verifyAccessToken, type AccessTokenPayload } from "../utils/tokens.js";

export interface AuthenticatedRequest extends Request {
  user?: AccessTokenPayload;
}

const extractToken = (req: Request) => {
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "").trim();
  }

  const cookieToken = req.cookies?.[env.accessTokenCookieName];
  return cookieToken;
};

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    });
  }
};

export const requireRole = (...roles: string[]) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Insufficient permissions"
      });
    }

    return next();
  };