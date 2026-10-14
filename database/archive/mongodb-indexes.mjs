import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
try {
  // MongoDB's ordinary unique indexes allow only one null value. Partial
  // indexes preserve uniqueness of assigned codes while allowing unset codes.
  await prisma.$runCommandRaw({
    createIndexes: "User",
    indexes: ["adminCode", "employeeId"].map((field) => ({
      key: { [field]: 1 },
      name: `User_${field}_unique_assigned`,
      unique: true,
      partialFilterExpression: { [field]: { $type: "string" } }
    }))
  });
} finally {
  await prisma.$disconnect();
}
