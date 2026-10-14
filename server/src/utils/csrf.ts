import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

const cookieOptions = {
  httpOnly: false,
  sameSite: env.cookieSameSite,
  secure: env.nodeEnv === "production",
  path: "/",
  ...(env.cookieDomain ? { domain: env.cookieDomain } : {})
};

export const issueCsrfToken = (res: Response) => {
  const token = crypto.randomBytes(32).toString("hex");
  res.cookie(env.csrfCookieName, token, cookieOptions);
  return token;
};

export const csrfProtection = (req: Request, res: Response, next: NextFunction) => {
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next();
  }

  const headerToken = req.header("x-csrf-token");
  const cookieToken = req.cookies?.[env.csrfCookieName];

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({
      success: false,
      message: "Invalid CSRF token"
    });
  }

  return next();
};
