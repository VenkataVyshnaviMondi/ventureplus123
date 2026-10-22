import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withIsolatedDatabase } from "./isolated-config.mjs";
import { readPolicy, enterRuntime } from "./isolated-runtime.mjs";

// Opt-in only: owner must verify a dedicated schema/account, never production.
// This starts the API locally using the SAME Prisma connection being checked.
// It accepts no remote API target and runs no schema changes or migrations.
let stage = "isolation prerequisites";
try {
  await withIsolatedDatabase(process.env, {
    readPolicy, enterRuntime, execArgv: process.execArgv,
    loadPrisma: async () => (await import("../dist/config/prisma.js")).prisma
  }, async ({ prisma, config }) => {
  let server, userId;
  const recordIds = new Set();
  try {
  const appImport = relative => import(pathToFileURL(path.join(config.appCheckout, relative)).href);
  const { createApiClient } = await appImport("shared/api-client.ts");
  const { nativeSessionSchema } = await appImport("shared/auth-contracts.ts");
  const { recordSchema } = await appImport("mobile/src/features/crm/contracts.ts");
  const { createCsrfFetch } = await import("../../client/src/services/csrf-fetch.ts");
  const { default: bcrypt } = await import("bcryptjs");
  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp()); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const run = randomUUID(), email = `${run}@example.test`, password = randomBytes(32).toString("hex");
  stage = "synthetic account setup";
  const user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 12),
    role: "ADMIN", displayName: `Integration ${run}`, fullName: `Integration ${run}` } });
  userId = user.id;
  const cookies = new Map();
  const webSend = createCsrfFetch({ baseUrl: base, readCookie: () => cookies.get("estatehub_csrf") ?? null,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10000) });
      for (const item of response.headers.getSetCookie()) {
        const pair = item.split(";", 1)[0], index = pair.indexOf("="); cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    } });
  const web = async (route, method = "GET", body) => {
    const response = await webSend(route, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, `Browser API ${method} returned HTTP ${response.status}`);
    const result = await response.json(); assert.equal(result.success, true); return result;
  };
  let token = null;
  const mobile = createApiClient({ baseUrl: base, getToken: async () => token,
    onUnauthorized: () => { token = null; } });
  stage = "browser and native authentication";
  assert.equal((await web("/auth/login", "POST", { email, password, expectedRole: "ADMIN" })).data.user.id, user.id);
  const session = nativeSessionSchema.parse((await mobile.request("/auth/native/login", {
    method: "POST", authenticated: false, body: { email, password, expectedRole: "ADMIN" }
  })).data);
  token = session.token; assert.equal(session.user.id, user.id);
  assert.equal((await mobile.request("/auth/me")).data.user.id, user.id);
  const input = { contactName: `Synthetic ${run}`, contactNumber: "1234567890", location: "Test location", budget: "100",
    recordOwner: user.fullName, leadName: user.fullName, notes: `Synthetic run ${run}` };
  stage = "website create, native read and update, website read";
  const created = (await web("/total-data", "POST", input)).data; recordIds.add(created.id);
  const nativeRows = (await mobile.request("/total-data", { query: { page: 1, pageSize: 100 } })).data;
  assert.equal(recordSchema.parse(nativeRows.find(row => row.id === created.id)).budget, "100");
  await mobile.request(`/total-data/${created.id}`, { method: "PUT", body: { ...input, budget: "200" } });
  assert.equal((await web("/total-data?page=1&pageSize=100")).data.find(row => row.id === created.id).budget, "200");
  stage = "native create, website read and update, native read";
  const nativeCreated = (await mobile.request("/total-data", { method: "POST", body: { ...input, contactName: `Reverse ${run}` } })).data;
  recordIds.add(nativeCreated.id);
  assert((await web("/total-data?page=1&pageSize=100")).data.some(row => row.id === nativeCreated.id));
  await web(`/total-data/${nativeCreated.id}`, "PUT", { ...input, contactName: `Reverse ${run}`, budget: "300" });
  const updated = (await mobile.request("/total-data", { query: { page: 1, pageSize: 100 } })).data.find(row => row.id === nativeCreated.id);
  assert.equal(recordSchema.parse(updated).budget, "300");
  assert.equal((await prisma.customerRecord.findUnique({ where: { id: nativeCreated.id } })).budget, "300");
  stage = "browser and native logout";
  await web("/auth/logout", "POST");
  assert.equal((await webSend("/auth/me")).status, 401);
  await mobile.request("/auth/logout", { method: "POST" }); token = null;
  await assert.rejects(mobile.request("/auth/me"));
  } finally {
    try {
    // Only this invocation's known synthetic IDs; never broad cleanup or seeding.
    for (const id of recordIds) await prisma.customerRecord.deleteMany({ where: { id } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    } catch {
      stage = "synthetic cleanup";
      throw new Error("Synthetic cleanup requires owner review");
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
  }
  });
  console.log("PASS: browser-cookie and actual native-client authentication and bidirectional customer-record consistency against isolated MySQL");
} catch {
  console.error(`BLOCKED/FAIL: ${stage}. No credentials or raw database errors are printed.`);
  process.exitCode = 1;
}
