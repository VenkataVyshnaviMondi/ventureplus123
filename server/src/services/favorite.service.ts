import { prisma } from "../config/prisma.js";

export const listFavorites = async (userId: string) => {
  return prisma.favorite.findMany({
    where: { userId },
    include: {
      plot: {
        include: {
          venture: { include: { location: true } }
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });
};

export const addFavorite = async (userId: string, plotId: string) => {
  return prisma.favorite.create({
    data: {
      userId,
      plotId
    }
  });
};

export const removeFavorite = async (userId: string, plotId: string) => {
  return prisma.favorite.delete({
    where: {
      userId_plotId: {
        userId,
        plotId
      }
    }
  });
};