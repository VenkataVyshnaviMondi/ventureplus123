import "dotenv/config";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

assert(/^mysql:\/\//.test(process.env.DATABASE_URL || ""), "Configure a MySQL DATABASE_URL");
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
assert(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Set a valid ADMIN_EMAIL");
assert(password && password.length >= 12, "Set ADMIN_PASSWORD with at least 12 characters");
const prisma = new PrismaClient();
try {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    assert.equal(existing.role, "ADMIN", "An existing non-admin owns this email");
    console.log("Administrator already exists; credentials were not changed");
  } else {
    await prisma.user.create({ data: {
      email, passwordHash: await bcrypt.hash(password, 12), role: "ADMIN",
      displayName: process.env.ADMIN_NAME || "Administrator",
      fullName: process.env.ADMIN_NAME || "Administrator",
      adminCode: process.env.ADMIN_CODE?.trim() || null
    }});
    console.log("Administrator provisioned");
  }
} finally {
  await prisma.$disconnect();
}
