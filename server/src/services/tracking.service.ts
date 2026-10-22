import { prisma } from "../config/prisma.js";
import type { TrackingStatus } from "@prisma/client";
import { customerEmailScope } from "./customerAccess.js";

export interface TrackingUpdateInput {
  customerId: string;
  latitude: number;
  longitude: number;
  status?: TrackingStatus;
  address?: string;
  updatedBy?: string;
}

export const listTrackingUpdates = async (requester?: { role?: string; email?: string }) => {
  const where =
    requester?.role === "CUSTOMER"
      ? {
          customer: customerEmailScope(requester.email)
        }
      : undefined;

  return prisma.trackingUpdate.findMany({
    where,
    orderBy: { updatedAt: "desc" }
  });
};

export const upsertTrackingUpdate = async (update: TrackingUpdateInput) => {
  return prisma.trackingUpdate.upsert({
    where: { customerId: update.customerId },
    create: {
      customerId: update.customerId,
      latitude: update.latitude,
      longitude: update.longitude,
      status: update.status,
      address: update.address,
      updatedBy: update.updatedBy
    },
    update: {
      latitude: update.latitude,
      longitude: update.longitude,
      status: update.status,
      address: update.address,
      updatedBy: update.updatedBy
    }
  });
};
