declare module "compression";
declare module "hpp";
declare module "ws";
declare module "cookie";
declare module "multer";

declare namespace Express {
  namespace Multer {
    interface File {
      buffer: Buffer;
    }
  }
}
