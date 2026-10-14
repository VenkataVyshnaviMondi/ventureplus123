import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { createVenture, getVentures, getVenture, uploadVentureLayout, uploadVenturePhoto, updateRegions } from "../controllers/ventures.controller.js";
import { cacheResponse } from "../middleware/cache.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import multer from "multer";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, acceptFile: boolean) => void) => {
    const allowed = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/svg+xml"];
    cb(null, allowed.includes(file.mimetype));
  },
  limits: { fileSize: 4 * 1024 * 1024 }
});

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, acceptFile: boolean) => void) => {
    const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
  limits: { fileSize: 4 * 1024 * 1024 }
});

const createVentureSchema = z.object({
  name: z.string().min(1),
  locationName: z.string().trim().min(1),
  plotCount: z.number().int().min(1).max(200),
  plotNumberPrefix: z.string().optional(),
  startingPlotNumber: z.number().int().min(1).optional(),
  defaultArea: z.number().int().min(1),
  defaultPricePerSqYard: z.number().int().min(1)
});

router.post(
  "/ventures",
  requireAuth,
  requireRole("ADMIN"),
  validate({ body: createVentureSchema }),
  asyncHandler(createVenture)
);
router.get("/ventures", requireAuth, cacheResponse(60), asyncHandler(getVentures));
router.get("/ventures/:id", requireAuth, asyncHandler(getVenture));
router.post(
  "/ventures/:id/layout",
  requireAuth,
  requireRole("ADMIN"),
  upload.single("layout"),
  asyncHandler(uploadVentureLayout)
);
router.post(
  "/ventures/:id/photo",
  requireAuth,
  requireRole("ADMIN"),
  uploadPhoto.single("photo"),
  asyncHandler(uploadVenturePhoto)
);
router.put(
  "/ventures/:id/regions",
  requireAuth,
  requireRole("ADMIN"),
  asyncHandler(updateRegions)
);

export default router;
