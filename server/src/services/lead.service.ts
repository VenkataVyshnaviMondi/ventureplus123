import { prisma } from "../config/prisma.js";
import { getPagination } from "../utils/pagination.js";
import { customerRecordScope, employeeOwnerAliases, type CustomerRequester } from "./customerAccess.js";
import { HttpError } from "../utils/httpError.js";

export const listLeads = async (filters: {
  plotId?: string;
  page?: number;
  pageSize?: number;
  requester?: { role?: string; email?: string };
}) => {
  const { skip, take, page, pageSize } = getPagination(filters.page, filters.pageSize);

  const where: any = {};
  if (filters.plotId) where.plotId = filters.plotId;
  if (filters.requester?.role === "CUSTOMER" && filters.requester.email) {
    where.email = filters.requester.email;
  }

  const [total, leads] = await Promise.all([
    prisma.lead.count({ where: Object.keys(where).length ? where : undefined }),
    prisma.lead.findMany({
      where: Object.keys(where).length ? where : undefined,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      include: {
        plot: {
          include: {
            venture: true
          }
        }
      }
    })
  ]);

  return {
    data: leads,
    pagination: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize)
    }
  };
};

export const createLead = async (input: {
  plotId: string;
  plotNumber?: string;
  customerName: string;
  email: string;
  contactNumber: string;
  location: string;
  uniqueId: string;
  pricePerSqYard: number;
  notes?: string;
  photoUrl?: string;
  agentId?: string;
}, requester?: CustomerRequester) => {
  if (!requester || !["ADMIN", "EMPLOYEE"].includes(requester.role ?? "")) {
    throw new HttpError(403, "Insufficient permissions");
  }
  const scope = await customerRecordScope(requester);
  const employeeOwner = requester.role === "EMPLOYEE" ? (await employeeOwnerAliases(requester))[0] : undefined;
  if (requester.role === "EMPLOYEE" && !employeeOwner) throw new HttpError(403, "Employee ownership requires administrator review");
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        plotId: input.plotId,
        customerName: input.customerName,
        email: input.email,
        contactNumber: input.contactNumber,
        location: input.location,
        uniqueId: input.uniqueId,
        pricePerSqYard: input.pricePerSqYard,
        notes: input.notes,
        photoUrl: input.photoUrl,
        agentId: input.agentId
      }
    });

    const [plot, agent] = await Promise.all([
      tx.plot.findUnique({
        where: { id: input.plotId },
        include: {
          venture: {
            include: { location: true }
          }
        }
      }),
      input.agentId ? tx.user.findUnique({ where: { id: input.agentId } }) : Promise.resolve(null)
    ]);

    const recordOwner = employeeOwner || agent?.fullName || agent?.displayName || agent?.email || "Unknown";
    const ventureName = plot?.venture?.name || "";
    const plotInterested = plot?.plotNumber || input.plotNumber || "";
    const locationName = plot?.venture?.location?.name || input.location;

    const headerLines: string[] = [];
    if (ventureName) headerLines.push(`Venture: ${ventureName}`);
    if (plotInterested) headerLines.push(`Plot Interested: ${plotInterested}`);

    const metaLines: string[] = [];
    if (input.email) metaLines.push(`Email: ${input.email}`);
    if (input.uniqueId) metaLines.push(`Unique ID: ${input.uniqueId}`);

    const incomingNotes = input.notes?.trim();

    const existing = await tx.customerRecord.findFirst({
      where: {
        contactName: input.customerName,
        contactNumber: input.contactNumber,
        location: locationName
      },
      orderBy: { createdAt: "desc" }
    });

    const mergeNotes = (existingNotes: string | null | undefined) => {
      const existingLines = (existingNotes || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter(
          (l) =>
            !/^venture:\s*/i.test(l) &&
            !/^plot interested:\s*/i.test(l) &&
            !/^email:\s*/i.test(l) &&
            !/^unique id:\s*/i.test(l)
        );

      const combined = [
        ...headerLines,
        ...metaLines,
        ...existingLines,
        ...(incomingNotes ? [incomingNotes] : [])
      ].filter(Boolean);

      // de-dupe while preserving order
      const seen = new Set<string>();
      return combined.filter((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).join("\n") || undefined;
    };

    if (existing) {
      await tx.customerRecord.update({
        where: { id: existing.id, AND: [scope] },
        data: {
          budget: String(input.pricePerSqYard),
          interested: true,
          status: "HOT_LEAD",
          recordOwner,
          leadName: recordOwner,
          notes: mergeNotes(existing.notes)
        }
      });
    } else {
      await tx.customerRecord.create({
        data: {
          contactName: input.customerName,
          contactNumber: input.contactNumber,
          location: locationName,
          budget: String(input.pricePerSqYard),
          interested: true,
          status: "HOT_LEAD",
          recordOwner,
          leadName: recordOwner,
          notes: mergeNotes("")
        }
      });
    }

    return lead;
  });
};

export const updateLead = async (id: string, update: {
  notes?: string;
  status?: string;
  pricePerSqYard?: number;
  contactNumber?: string;
  location?: string;
  uniqueId?: string;
}) => {
  return prisma.lead.update({
    where: { id },
    data: {
      notes: update.notes,
      status: update.status as any,
      pricePerSqYard: update.pricePerSqYard,
      contactNumber: update.contactNumber,
      location: update.location,
      uniqueId: update.uniqueId
    }
  });
};

export const deleteLead = async (id: string) => {
  return prisma.lead.delete({
    where: { id }
  });
};
