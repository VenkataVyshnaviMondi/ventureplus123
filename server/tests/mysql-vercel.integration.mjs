import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl && /^mysql:/.test(databaseUrl), "Provide the isolated MySQL URL");
assert(new URL(databaseUrl).pathname.endsWith("_test"), "Refusing to write to a non-test database");
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3100";
const prisma = new PrismaClient();
const run = randomUUID();
const email = `${run}@example.test`;
const password = "Isolated-test-password-123";
const cookies = new Map();

async function api(path, method = "GET", body) {
  const multipart = body instanceof FormData;
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Origin: new URL(base).origin,
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      ...(cookies.has("estatehub_csrf") ? { "x-csrf-token": cookies.get("estatehub_csrf") } : {}),
      ...(!multipart && body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const payload = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
  assert.equal(payload.success, true);
  return payload;
}

try {
  await prisma.user.create({ data: {
    email, passwordHash: await bcrypt.hash(password, 12), role: "ADMIN",
    displayName: "Integration Admin", fullName: "Integration Admin"
  }});
  await api("/api/health");
  await api("/api/auth/csrf");
  const login = await api("/api/auth/login", "POST", { email, password });
  assert.equal(login.data.user.role, "ADMIN");
  assert(cookies.has("estatehub_access"), "Gateway must preserve authentication cookies");
  assert.equal((await api("/api/auth/me")).data.user.email, email);

  const venture = (await api("/api/ventures", "POST", {
    name: `Test ${run}`, locationName: `Location ${run}`, plotCount: 2,
    defaultArea: 100, defaultPricePerSqYard: 1000
  })).data;
  assert.equal(venture.plots.length, 2, "MySQL nested writes must create plots");
  const plotId = venture.plots[0].id;
  assert.equal((await api(`/api/ventures/${venture.id}`)).data.plots.length, 2);
  await api("/api/locations"); // Includes MySQL groupBy and relation filters.
  await api("/api/stats");
  await api("/api/plots/coords", "PUT", { plots: [{ id: plotId, x: 0.2, y: 0.3 }] });
  await api("/api/favorites", "POST", { plotId });
  assert((await api("/api/favorites")).data.length > 0);

  const employee = (await api("/api/employee-access/employees", "POST", {
    email: `employee-${email}`, password, fullName: "Test Employee",
    assignedLocationIds: [venture.locationId], assignedVentureIds: [venture.id]
  })).data;
  const assignments = await prisma.employeeAssignment.findUnique({ where: { userId: employee.id } });
  assert.deepEqual(assignments.assignedVentureIds, [venture.id]);
  const secondEmployee = (await api("/api/employee-access/employees", "POST", {
    email: `second-${email}`, password, fullName: "Second Employee"
  })).data;
  assert(secondEmployee.id, "Multiple null employee codes must remain valid");

  await api("/api/leads", "POST", {
    plotId, customerName: `Customer ${run}`, email: `customer-${email}`,
    contactNumber: "1234567890", location: `Location ${run}`,
    uniqueId: run, pricePerSqYard: 1000
  });
  const customer = await prisma.customerRecord.findFirst({ where: { contactName: `Customer ${run}` } });
  assert(customer, "Lead transaction must create the linked customer record");
  await api("/api/tracking", "POST", { customerId: customer.id, latitude: 17.4, longitude: 78.4, status: "active" });
  await api("/api/tracking");

  const challenge = (await api("/api/employee-access/otp/request", "POST", { type: "email", target: email })).data;
  assert(await prisma.otpRequest.findUnique({ where: { id: challenge.requestId } }));
  await api("/api/employee-access/otp/verify", "POST", { requestId: challenge.requestId, otp: challenge.otp });

  const bytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>");
  const form = new FormData();
  form.append("layout", new Blob([bytes], { type: "image/svg+xml" }), "layout.svg");
  await api(`/api/ventures/${venture.id}/layout`, "POST", form);
  const stored = await prisma.venture.findUnique({ where: { id: venture.id } });
  assert(stored.layoutImage.startsWith("/uploads/assets/"));
  const assetResponse = await fetch(new URL(stored.layoutImage, base));
  assert(assetResponse.ok, "Upload rewrite must reach the internal application");
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), bytes);

  const streamController = new AbortController();
  const stream = await fetch(new URL("/api/stream", base), {
    headers: {
      Accept: "text/event-stream",
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ")
    },
    signal: AbortSignal.any([streamController.signal, AbortSignal.timeout(15000)])
  });
  assert.equal(stream.headers.get("content-type").split(";")[0], "text/event-stream");
  const reader = stream.body.getReader();
  const firstEvent = await reader.read();
  assert(new TextDecoder().decode(firstEvent.value).includes("event: connected"));
  await api(`/api/favorites/${plotId}`, "DELETE");
  let eventText = "";
  while (!eventText.includes("event: favorite.deleted")) {
    const chunk = await reader.read();
    assert(!chunk.done, "SSE stream closed before receiving an update");
    eventText += new TextDecoder().decode(chunk.value);
  }
  streamController.abort();

  const unknown = await fetch(new URL("/api/does-not-exist", base));
  assert.equal(unknown.status, 404);
  const deepLink = await fetch(new URL("/employee-access", base));
  assert(deepLink.ok && (await deepLink.text()).includes('<div id="root">'));
  await api("/api/auth/logout", "POST");
  console.log("PASS: login/cookies/CSRF, nested MySQL writes, assignments, transactions, stats, tracking, OTP, persistent uploads, SSE, API 404 and SPA deep link");
} finally {
  await prisma.$disconnect();
}
