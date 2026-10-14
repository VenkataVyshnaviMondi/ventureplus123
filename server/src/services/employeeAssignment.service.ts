import { prisma } from "../config/prisma.js";

const stringIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

const normalizeAssignment = (row: { assignedLocationIds: unknown; assignedVentureIds: unknown } | null) => ({
  assignedLocationIds: stringIds(row?.assignedLocationIds),
  assignedVentureIds: stringIds(row?.assignedVentureIds)
});

export const getEmployeeAssignment = async (userId: string) => {
  const row = await prisma.employeeAssignment.findUnique({ where: { userId } });
  return normalizeAssignment(row);
};

export const getEmployeeAssignmentMap = async (userIds: string[]) => {
  const rows = await prisma.employeeAssignment.findMany({ where: { userId: { in: userIds } } });
  return new Map(rows.map((row) => [row.userId, normalizeAssignment(row)]));
};

export const upsertEmployeeAssignment = async (
  userId: string, assignedLocationIds: string[], assignedVentureIds: string[]
) => prisma.employeeAssignment.upsert({
  where: { userId },
  create: { userId, assignedLocationIds, assignedVentureIds },
  update: { assignedLocationIds, assignedVentureIds }
}).then(normalizeAssignment);
