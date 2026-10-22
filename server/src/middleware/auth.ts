import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { verifyAccessToken, type AccessTokenPayload } from "../utils/tokens.js";
import { prisma } from "../config/prisma.js";
import { logger } from "../config/logger.js";
import { HttpError } from "../utils/httpError.js";

export interface AuthenticatedRequest extends Request {
  user?: AccessTokenPayload;
}

export const extractToken = (req: Request) => {
  const authHeader = req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "").trim();
  }

  const cookieToken = req.cookies?.[env.accessTokenCookieName];
  return cookieToken;
};

export const resolveSession = async (token?: string): Promise<AccessTokenPayload> => {
  if (!token) throw new HttpError(401, "Authentication required");
  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new HttpError(401, "Invalid or expired token");
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, email: true, displayName: true, employeeProfile: { select: { status: true, dateOfRelieving: true } } }
    });
    if (!user || user.role !== payload.role) {
      throw new HttpError(401, "Session is no longer valid");
    }
    const profile = user.employeeProfile;
    if (user.role === "EMPLOYEE" && (profile?.status === "FROZEN" ||
        (profile?.dateOfRelieving && profile.dateOfRelieving <= new Date()))) {
      throw new HttpError(403, "Employee account is frozen");
    }
    return { ...payload, email: user.email, displayName: user.displayName };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logger.error({ event: "auth_session_backend_failure" }, "Session validation backend failed");
    throw new HttpError(500, "Unable to validate session. Please try again later.");
  }
};

export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    req.user = await resolveSession(extractToken(req));
    res.setHeader("Cache-Control", "private, no-store");
    return next();
  } catch (error) {
    const failure = error as HttpError;
    return res.status(failure.statusCode || 500).json({ success: false, message: failure.message });
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
