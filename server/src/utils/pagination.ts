export const getPagination = (page?: number, pageSize?: number) => {
  const safePage = Math.max(1, page ?? 1);
  const safeSize = Math.min(100, Math.max(1, pageSize ?? 20));
  const skip = (safePage - 1) * safeSize;

  return {
    page: safePage,
    pageSize: safeSize,
    skip,
    take: safeSize
  };
};