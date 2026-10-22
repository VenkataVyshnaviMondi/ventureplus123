import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export interface CustomerRequester {
  userId?: string;
  role?: string;
  email?: string;
  displayName?: string;
}

export const customerEmailScope = (email?: string): Prisma.CustomerRecordWhereInput => {
  if (!email) return { id: { in: [] } };
  const line = `Email: ${email}`;
  const likeLine = line.replace(/[\\%_]/g, value => `\\${value}`);
  // Match whole metadata lines, not substrings of another address or prose.
  return { OR: [
    { notes: { equals: email } }, { notes: { equals: line } },
    { notes: { startsWith: `${likeLine}\n` } }, { notes: { startsWith: `${likeLine}\r\n` } },
    { notes: { endsWith: `\n${likeLine}` } }, { notes: { endsWith: `\n${likeLine}\r` } },
    { notes: { contains: `\n${likeLine}\n` } }, { notes: { contains: `\n${likeLine}\r\n` } }
  ] };
};

export const employeeOwnerAliases = async (requester: CustomerRequester) => {
  if (!requester.userId) return [];
  const user = await prisma.user.findUnique({
    where: { id: requester.userId },
    select: { fullName: true, displayName: true, email: true, employeeId: true }
  });
  // Use current database identity, never stale aliases from a signed token.
  const aliases = [...new Set([user?.fullName, user?.displayName, user?.email, user?.employeeId]
    .map(value => value?.trim()).filter((value): value is string => Boolean(value)))];
  // Public registration can choose names. A duplicate name must never confer
  // ownership of another account's legacy records. Let MySQL apply its collation.
  const exclusive = await Promise.all(aliases.map(async alias => {
    const others = await prisma.user.count({ where: {
      id: { not: requester.userId },
      OR: [{ fullName: alias }, { displayName: alias }, { email: alias }, { employeeId: alias }]
    } });
    return others === 0 ? alias : null;
  }));
  return exclusive.filter((alias): alias is string => alias !== null);
};

export const customerRecordScope = async (requester?: CustomerRequester): Promise<Prisma.CustomerRecordWhereInput> => {
  if (requester?.role === "ADMIN" || requester?.role === "AGENT") return {};
  if (requester?.role === "EMPLOYEE") {
    const aliases = await employeeOwnerAliases(requester);
    return { OR: [{ leadName: { in: aliases } }, { recordOwner: { in: aliases } }] };
  }
  if (requester?.role === "CUSTOMER" && requester.email) {
    return customerEmailScope(requester.email);
  }
  return { id: { in: [] } };
};

// Deleted records no longer exist to query. Only the publisher's internal snapshot
// is used here; it must never be forwarded to a client.
export const canReadDeletedCustomer = async (record: { leadName?: string; recordOwner?: string; notes?: string | null }, requester: CustomerRequester) => {
  if (requester.role === "ADMIN" || requester.role === "AGENT") return true;
  if (requester.role === "EMPLOYEE") {
    const aliases = await employeeOwnerAliases(requester);
    const normalized = aliases.map(alias => alias.toLowerCase());
    return normalized.includes((record.leadName ?? "").toLowerCase()) || normalized.includes((record.recordOwner ?? "").toLowerCase());
  }
  return requester.role === "CUSTOMER" && Boolean(requester.email && record.notes?.split(/\r?\n/)
    .some(line => [requester.email!.toLowerCase(), `email: ${requester.email!.toLowerCase()}`].includes(line.toLowerCase())));
};
