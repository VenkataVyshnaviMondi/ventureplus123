import { Router } from "express";
import { getLocation, getLocations } from "../controllers/locations.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.get("/locations", requireAuth, asyncHandler(getLocations));
router.get("/locations/:id", requireAuth, asyncHandler(getLocation));

export default router;
