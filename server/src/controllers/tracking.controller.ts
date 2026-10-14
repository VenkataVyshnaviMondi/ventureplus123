import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { TrackingStatus } from "@prisma/client";
import { publishEvent } from "../realtime/events.js";
import { listTrackingUpdates, upsertTrackingUpdate } from "../services/tracking.service.js";

export const listTracking = async (req: AuthenticatedRequest, res: Response) => {
  const updates = await listTrackingUpdates({ role: req.user?.role, email: req.user?.email });
  return res.json({
    success: true,
    data: updates,
    message: `Found ${updates.length} tracking updates`
  });
};

export const upsertTracking = async (req: AuthenticatedRequest, res: Response) => {
  const normalizedStatus = req.body.status
    ? (String(req.body.status).toUpperCase() as TrackingStatus)
    : undefined;

  const saved = await upsertTrackingUpdate({
    customerId: req.body.customerId,
    latitude: req.body.latitude,
    longitude: req.body.longitude,
    status: normalizedStatus,
    address: req.body.address,
    updatedBy: req.user?.sub
  });

  await publishEvent("tracking.updated", { tracking: saved });

  return res.json({
    success: true,
    data: saved,
    message: "Tracking updated"
  });
};
