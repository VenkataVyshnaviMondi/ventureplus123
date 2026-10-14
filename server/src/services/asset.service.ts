import { prisma } from "../config/prisma.js";
import { randomUUID } from "node:crypto";

export const saveVentureAsset = async (ventureId: string, file: Express.Multer.File) => {
  const id = randomUUID();
  await prisma.ventureAsset.create({
    data: { id, ventureId, filename: file.originalname, contentType: file.mimetype, data: file.buffer }
  });
  return `/uploads/assets/${id}`;
};
