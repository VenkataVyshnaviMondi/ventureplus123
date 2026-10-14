import { prisma } from "../config/prisma.js";
import { getPagination } from "../utils/pagination.js";

type CustomerStatus = "HOT_LEAD" | "FOLLOWING_UP" | "CONFIRMED_NOT_PAID" | "PAID_ADVANCE" | "BOOKED";

const deriveInterestedFromStatus = (status?: CustomerStatus) => {
  if (!status) return undefined;
  return status !== "FOLLOWING_UP";
};

export const listCustomerRecords = async (filters: {
  page?: number;
  pageSize?: number;
  requester?: { userId?: string; role?: string; email?: string; displayName?: string };
}) => {
  const { skip, take, page, pageSize } = getPagination(filters.page, filters.pageSize);
  const where: any = {};

  if (filters.requester?.role === "CUSTOMER" && filters.requester.email) {
    where.OR = [
      { notes: { contains: `Email: ${filters.requester.email}` } },
      { notes: { contains: filters.requester.email } }
    ];
  }

  if (filters.requester?.role === "EMPLOYEE") {
    const ownerAliases = new Set<string>();
    if (filters.requester.email?.trim()) ownerAliases.add(filters.requester.email.trim());
    if (filters.requester.displayName?.trim()) ownerAliases.add(filters.requester.displayName.trim());

    if (filters.requester.userId) {
      const me = await prisma.user.findUnique({
        where: { id: filters.requester.userId },
        select: { fullName: true, displayName: true, email: true, employeeId: true }
      });

      if (me?.fullName?.trim()) ownerAliases.add(me.fullName.trim());
      if (me?.displayName?.trim()) ownerAliases.add(me.displayName.trim());
      if (me?.email?.trim()) ownerAliases.add(me.email.trim());
      if (me?.employeeId?.trim()) ownerAliases.add(me.employeeId.trim());
    }

    const aliases = Array.from(ownerAliases);
    if (!aliases.length) {
      where.id = "__no_employee_alias_match__";
    } else {
      where.OR = [
        ...(where.OR ?? []),
        { leadName: { in: aliases } },
        { recordOwner: { in: aliases } }
      ];
    }
  }

  const finalWhere = Object.keys(where).length ? where : undefined;

  const [total, records] = await Promise.all([
    prisma.customerRecord.count({ where: finalWhere }),
    prisma.customerRecord.findMany({
      where: finalWhere,
      skip,
      take,
      orderBy: [{ interested: "desc" }, { createdAt: "desc" }]
    })
  ]);

  return {
    data: records,
    pagination: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize)
    }
  };
};

export const createCustomerRecord = async (input: {
  contactName: string;
  contactNumber: string;
  location: string;
  budget: string;
  interested?: boolean;
  status?: CustomerStatus;
  recordOwner: string;
  leadName?: string;
  notes?: string;
}, requester?: { userId?: string; role?: string; email?: string; displayName?: string }) => {
  const ownerOverride =
    requester?.role === "EMPLOYEE"
      ? await prisma.user.findUnique({
          where: { id: requester.userId ?? "" },
          select: { fullName: true, displayName: true, email: true }
        })
      : null;

  const employeeOwner =
    ownerOverride?.fullName?.trim() ||
    ownerOverride?.displayName?.trim() ||
    ownerOverride?.email?.trim() ||
    requester?.displayName?.trim() ||
    requester?.email?.trim();

  const effectiveOwner = (employeeOwner || input.recordOwner || "Unknown").trim();
  const effectiveLeadName = (employeeOwner || input.leadName || input.recordOwner || "Unknown").trim();

  const interested = input.interested ?? deriveInterestedFromStatus(input.status) ?? false;

  return prisma.customerRecord.create({
    data: {
      contactName: input.contactName,
      contactNumber: input.contactNumber,
      location: input.location,
      budget: input.budget,
      interested,
      status: input.status ?? "FOLLOWING_UP",
      recordOwner: effectiveOwner,
      leadName: effectiveLeadName,
      notes: input.notes
    }
  });
};

export const updateCustomerRecord = async (id: string, update: {
  contactName: string;
  contactNumber: string;
  location: string;
  budget: string;
  interested?: boolean;
  status?: CustomerStatus;
  recordOwner: string;
  leadName?: string;
  notes?: string;
}, requester?: { userId?: string; role?: string; email?: string; displayName?: string }) => {
  const ownerOverride =
    requester?.role === "EMPLOYEE"
      ? await prisma.user.findUnique({
          where: { id: requester.userId ?? "" },
          select: { fullName: true, displayName: true, email: true }
        })
      : null;

  const employeeOwner =
    ownerOverride?.fullName?.trim() ||
    ownerOverride?.displayName?.trim() ||
    ownerOverride?.email?.trim() ||
    requester?.displayName?.trim() ||
    requester?.email?.trim();

  const effectiveOwner = (employeeOwner || update.recordOwner || "Unknown").trim();
  const effectiveLeadName = (employeeOwner || update.leadName || update.recordOwner || "Unknown").trim();

  const interested = update.interested ?? deriveInterestedFromStatus(update.status);

  return prisma.customerRecord.update({
    where: { id },
    data: {
      contactName: update.contactName,
      contactNumber: update.contactNumber,
      location: update.location,
      budget: update.budget,
      ...(typeof interested === "boolean" ? { interested } : {}),
      ...(update.status ? { status: update.status } : {}),
      recordOwner: effectiveOwner,
      leadName: effectiveLeadName,
      notes: update.notes
    }
  });
};

export const deleteCustomerRecord = async (id: string) => {
  return prisma.customerRecord.delete({
    where: { id }
  });
};
