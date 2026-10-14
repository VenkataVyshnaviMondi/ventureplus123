import { randomInt, randomUUID } from "crypto";
import { prisma } from "../config/prisma.js";

export type OtpType = "email" | "phone";
const OTP_TTL_MS = 5 * 60 * 1000;

export const requestOtp = async (input: { type: OtpType; target: string }) => {
  const trimmed = input.target.trim();
  const target = input.type === "email" ? trimmed.toLowerCase() : trimmed;
  if (!target) throw new Error("Target is required");
  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const requestId = randomUUID();
  const expiresAt = Date.now() + OTP_TTL_MS;
  await prisma.otpRequest.create({
    data: { id: requestId, type: input.type, target, otp, expiresAt: new Date(expiresAt) }
  });
  return { requestId, otp, expiresAt };
};

export const verifyOtp = async (input: { requestId: string; otp: string }) => {
  // Claim an attempt atomically; challenges work across function instances.
  const claim = await prisma.otpRequest.updateMany({
    where: {
      id: input.requestId, expiresAt: { gt: new Date() }, attempts: { lt: 5 },
      verifiedAt: null
    },
    data: { attempts: { increment: 1 } }
  });
  if (!claim.count) throw new Error("OTP request expired, already verified or attempts exhausted");
  const record = await prisma.otpRequest.findUniqueOrThrow({ where: { id: input.requestId } });
  if (record.otp !== input.otp.trim()) throw new Error("Invalid OTP");
  const verifiedAt = new Date();
  const verified = await prisma.otpRequest.updateMany({
    where: {
      id: input.requestId,
      verifiedAt: null
    },
    data: { verifiedAt }
  });
  if (!verified.count) throw new Error("OTP request already verified");
  return { type: record.type, target: record.target, verifiedAt: verifiedAt.getTime() };
};
