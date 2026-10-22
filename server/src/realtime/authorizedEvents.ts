import { prisma } from "../config/prisma.js";
import { resolveSession } from "../middleware/auth.js";
import type { AccessTokenPayload } from "../utils/tokens.js";
import { canReadDeletedCustomer, customerEmailScope, customerRecordScope } from "../services/customerAccess.js";
import { subscribe, type RealtimeEvent } from "./events.js";

export const projectEvent = async (event: RealtimeEvent, user: AccessTokenPayload): Promise<RealtimeEvent | null> => {
  const payload = event.payload as any;
  const requester = { userId: user.sub, ...user };
  let projected: unknown = {};
  switch (event.type) {
    case "customer.created":
    case "customer.updated": {
      if (typeof payload?.record?.id !== "string") return null;
      const record = await prisma.customerRecord.findFirst({
        where: { id: payload.record.id, AND: [await customerRecordScope(requester)] }, select: { id: true }
      });
      if (!record) return null;
      break;
    }
    case "customer.deleted":
      if (!payload?.record || !await canReadDeletedCustomer(payload.record, requester)) return null;
      break;
    case "lead.created":
    case "lead.updated":
    case "lead.deleted":
      if (!payload?.lead || (user.role === "CUSTOMER" &&
          (typeof payload.lead.email !== "string" || payload.lead.email.toLowerCase() !== user.email.toLowerCase()))) return null;
      break;
    case "tracking.updated": {
      if (typeof payload?.tracking?.customerId !== "string") return null;
      const where = user.role === "CUSTOMER" ? customerEmailScope(user.email) : {};
      if (!await prisma.customerRecord.findFirst({ where: { id: payload.tracking.customerId, AND: [where] }, select: { id: true } })) return null;
      const { customerId, latitude, longitude, status, address, updatedAt } = payload.tracking;
      projected = { tracking: { customerId, latitude, longitude, status, address, updatedAt } };
      break;
    }
    case "favorite.created":
    case "favorite.deleted":
      if (user.role !== "ADMIN" && payload?.userId !== user.sub) return null;
      break;
    case "inquiry.created":
      if (user.role !== "ADMIN") return null;
      projected = { inquiry: { customerName: payload?.inquiry?.customerName } };
      break;
    case "user.registered":
      if (user.role !== "ADMIN") return null;
      projected = { user: { email: payload?.user?.email } };
      break;
    case "plot.updated":
      break;
    default:
      return null;
  }
  // Never spread publisher data, internal audience snapshots, or Redis origin.
  return { id: event.id, type: event.type, createdAt: event.createdAt, payload: projected };
};

export const subscribeAuthorized = (token: string, send: (event: RealtimeEvent) => void, close: () => void) => {
  let stopped = false;
  let pending = 0;
  let queue = Promise.resolve();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubscribe();
  };
  const fail = () => { stop(); close(); };
  const unsubscribe = subscribe(event => {
    if (stopped) return;
    if (++pending > 64) { fail(); return; }
    queue = queue.then(async () => {
      if (stopped) return;
      const projected = await projectEvent(event, await resolveSession(token));
      // Projection can await database calls. Recheck before writing bytes.
      await resolveSession(token);
      if (!stopped && projected) send(projected);
    }).catch(fail).finally(() => { pending--; });
  });
  const timer = setInterval(() => { void resolveSession(token).catch(fail); }, 25000);
  timer.unref();
  return stop;
};
