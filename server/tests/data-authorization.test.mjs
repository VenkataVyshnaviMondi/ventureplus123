import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { Prisma } from "@prisma/client";

process.env.NODE_ENV = "production";
process.env.JWT_SECRET = randomBytes(32).toString("hex");
process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:3306/unused_authorization_test";
process.env.LOG_LEVEL = "silent";
const { prisma } = await import("../dist/config/prisma.js");
const { createApp } = await import("../dist/app.js");
const { attachWebSocketServer } = await import("../dist/realtime/ws.js");
const { publishEvent, subscribe } = await import("../dist/realtime/events.js");
const { projectEvent } = await import("../dist/realtime/authorizedEvents.js");
const { createLead } = await import("../dist/services/lead.service.js");

// In-memory Prisma boundary: no connection is made to the placeholder URL.
// Real MySQL/collation/transaction coverage remains an isolated-DB acceptance gate.
const lower = value => String(value ?? "").toLowerCase();
const literalLike = value => value.replace(/\\([\\%_])/g, "$1");
const matches = (record, where = {}) => Object.entries(where).every(([key, value]) => {
  if (key === "AND") return value.every(part => matches(record, part));
  if (key === "OR") return value.some(part => matches(record, part));
  if (value && typeof value === "object") return Object.entries(value).every(([op, expected]) => {
    if (op === "in") return expected.some(item => lower(item) === lower(record[key]));
    if (op === "equals") return lower(record[key]) === lower(expected);
    if (op === "contains") return lower(record[key]).includes(lower(literalLike(expected)));
    if (op === "startsWith") return lower(record[key]).startsWith(lower(literalLike(expected)));
    if (op === "endsWith") return lower(record[key]).endsWith(lower(literalLike(expected)));
    throw new Error(`Unsupported fixture operator ${op}`);
  });
  return record[key] === value;
});
const missing = () => new Prisma.PrismaClientKnownRequestError("Record not found", { code: "P2025", clientVersion: "5.22.0" });

test("customer ownership and realtime authorization", async t => {
  const users = [
    { id: "admin", role: "ADMIN", email: "admin@example.test", displayName: "Admin" },
    { id: "employee-a", role: "EMPLOYEE", email: "a@example.test", displayName: "Alice", fullName: "Alice Employee", employeeId: "EMP-A" },
    { id: "employee-b", role: "EMPLOYEE", email: "b@example.test", displayName: "Bob", fullName: "Bob Employee", employeeId: "EMP-B" },
    { id: "customer", role: "CUSTOMER", email: "alice@example.test", displayName: "Customer" },
    { id: "agent", role: "AGENT", email: "agent@example.test", displayName: "Agent" }
  ];
  const makeRecord = (id, owner, notes) => ({ id, recordOwner: owner, leadName: owner, notes,
    contactName: "Synthetic contact", contactNumber: "1234567890", location: "Synthetic location", budget: "100", status: "FOLLOWING_UP" });
  let records = [];
  let backendFailure = false;
  const restore = [];
  const replace = (object, key, value) => { const original = object[key]; object[key] = value; restore.push(() => { object[key] = original; }); };
  replace(prisma.user, "findUnique", async ({ where }) => {
    if (backendFailure) throw new Error("fixture backend unavailable");
    return users.find(user => user.id === where.id) ?? null;
  });
  replace(prisma.user, "count", async ({ where }) => users.filter(user => user.id !== where.id.not &&
    where.OR.some(part => Object.entries(part).every(([key, value]) => lower(user[key]) === lower(value)))).length);
  replace(prisma.customerRecord, "findFirst", async ({ where }) => records.find(record => matches(record, where)) ?? null);
  replace(prisma.customerRecord, "findMany", async ({ where }) => records.filter(record => matches(record, where)));
  replace(prisma.customerRecord, "count", async ({ where }) => records.filter(record => matches(record, where)).length);
  replace(prisma.customerRecord, "update", async ({ where, data }) => {
    const record = records.find(record => matches(record, where));
    if (!record) throw missing();
    return Object.assign(record, data);
  });
  replace(prisma.customerRecord, "delete", async ({ where }) => {
    const index = records.findIndex(record => matches(record, where));
    if (index < 0) throw missing();
    return records.splice(index, 1)[0];
  });
  t.after(() => restore.reverse().forEach(fn => fn()));
  const token = (user, expiresIn = 60) => jwt.sign({ sub: user.id, role: user.role, email: user.email, displayName: user.displayName }, process.env.JWT_SECRET, { expiresIn });
  const server = createServer(createApp());
  const wss = attachWebSocketServer(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { wss.clients.forEach(ws => ws.terminate()); await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (user, path, method = "GET", body) => fetch(`${base}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token(user)}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000)
  });
  const resetRecords = () => { records = [makeRecord("own", "Alice Employee", "Email: alice@example.test"), makeRecord("other", "Bob Employee", "Email: malice@example.test")]; };

  await t.test("employee can mutate own aliases but cannot take or delete another employee's record", async () => {
    resetRecords();
    const employee = users[1], other = structuredClone(records[1]);
    const events = []; const off = subscribe(event => events.push(event));
    try {
      const list = await request(employee, "/total-data");
      assert.deepEqual((await list.json()).data.map(record => record.id), ["own"]);
      for (const id of ["other", "missing"]) {
        assert.equal((await request(employee, `/total-data/${id}`, "PUT", { ...other, recordOwner: "Alice Employee" })).status, 404);
        assert.equal((await request(employee, `/total-data/${id}`, "DELETE")).status, 404);
      }
      assert.deepEqual(records[1], other); assert.equal(events.length, 0);
      assert.equal((await request(employee, "/total-data/own", "PUT", { ...records[0], budget: "200" })).status, 200);
      assert.equal(records[0].budget, "200");
      assert.equal((await request(employee, "/total-data/own", "DELETE")).status, 200);
      assert.deepEqual(events.map(event => event.type), ["customer.updated", "customer.deleted"]);
    } finally { off(); }
  });
  await t.test("admin retains cross-owner mutation permissions; customer and agent cannot write", async () => {
    resetRecords();
    for (const user of users.slice(3)) for (const method of ["PUT", "DELETE"]) {
      assert.equal((await request(user, "/total-data/other", method, method === "PUT" ? records[1] : undefined)).status, 403);
    }
    assert.equal((await request(users[0], "/total-data/other", "PUT", { ...records[1], budget: "300" })).status, 200);
    assert.equal((await request(users[0], "/total-data/other", "DELETE")).status, 200);
  });
  await t.test("current identity aliases are accepted; obsolete token aliases are not", async () => {
    resetRecords();
    const user = users[1], oldToken = token(user), oldName = user.displayName;
    user.displayName = "Renamed";
    records.push(makeRecord("stale", oldName, ""), makeRecord("current", "Renamed", ""), makeRecord("code", user.employeeId, ""));
    try {
      const response = await fetch(`${base}/api/total-data`, { headers: { Authorization: `Bearer ${oldToken}` } });
      assert.deepEqual((await response.json()).data.map(record => record.id), ["own", "current", "code"]);
    } finally { user.displayName = oldName; }
  });
  await t.test("customer email ownership uses complete metadata lines, never another email or prose", async () => {
    resetRecords();
    records.push(makeRecord("prose", "Bob", "Call alice@example.test for another customer"));
    records.push(makeRecord("crlf", "Bob", "Venture: Test\r\nEmail: alice@example.test\r\nDetails"));
    const response = await request(users[3], "/total-data");
    assert.deepEqual((await response.json()).data.map(record => record.id), ["own", "crlf"]);
  });
  await t.test("self-registered lookalike names cannot confer legacy record ownership", async () => {
    resetRecords();
    const attacker = { id: "lookalike", role: "EMPLOYEE", email: "lookalike@example.test", displayName: "Alice", fullName: "Alice Employee" };
    users.push(attacker);
    try {
      const response = await request(attacker, "/total-data");
      assert.deepEqual((await response.json()).data, []);
      assert.equal((await request(attacker, "/total-data/own", "PUT", records[0])).status, 404);
      assert.equal((await request(attacker, "/total-data/own", "DELETE")).status, 404);
      assert.equal(records[0].recordOwner, "Alice Employee");
      // Ambiguous name records fail closed for either account until reviewed.
      assert.equal((await request(users[1], "/total-data/own", "DELETE")).status, 404);
    } finally { users.pop(); }
  });
  await t.test("SQL LIKE metacharacters in identity metadata are escaped", async () => {
    const { customerEmailScope } = await import("../dist/services/customerAccess.js");
    const scope = customerEmailScope("a_b%test@example.test");
    const patterns = scope.OR.flatMap(part => [part.notes.contains, part.notes.startsWith, part.notes.endsWith].filter(Boolean));
    assert(patterns.every(value => value.includes("a\\_b\\%test@example.test")));
    assert(scope.OR.some(part => part.notes.equals === "Email: a_b%test@example.test"));
  });
  await t.test("lead conversion cannot bypass atomic ownership checks", async () => {
    resetRecords();
    let mutationWhere;
    const original = prisma.$transaction;
    prisma.$transaction = async callback => callback({
      lead: { create: async ({ data }) => ({ id: "lead", ...data }) },
      plot: { findUnique: async () => null }, user: { findUnique: async () => users[1] },
      customerRecord: {
        findFirst: async () => records[1],
        update: async ({ where }) => { mutationWhere = where; if (!matches(records[1], where)) throw missing(); }
      }
    });
    try {
      await assert.rejects(createLead({ customerName: "Synthetic", contactNumber: "123456", location: "Test", pricePerSqYard: 1, email: "synthetic@example.test", uniqueId: "fixture", plotId: "plot" }, { userId: users[1].id, role: "EMPLOYEE" }), error => error.code === "P2025");
      assert(mutationWhere.AND, "Ownership must be part of the database mutation");
    } finally { prisma.$transaction = original; }
  });
  await t.test("inventory refresh sees changes immediately and revoked assignments cannot reuse cached access", async () => {
    let assigned = true, label = "Before update";
    replace(prisma.employeeProfile, "findUnique", async () => null);
    replace(prisma.employeeAssignment, "findUnique", async () => ({ assignedLocationIds: assigned ? ["location"] : [], assignedVentureIds: [] }));
    replace(prisma.location, "findMany", async () => [{ id: "location", name: label, ventures: [] }]);
    replace(prisma.venture, "findMany", async () => [{ id: "venture", locationId: "location", name: label }]);
    replace(prisma.plot, "groupBy", async () => []);
    for (const endpoint of ["/locations", "/ventures"]) {
      assigned = true; label = "Before update";
      const first = await request(users[1], endpoint);
      assert.equal(first.headers.get("cache-control"), "private, no-store");
      assert.equal((await first.json()).data[0].name, label);
      label = "After update";
      assert.equal((await (await request(users[1], endpoint)).json()).data[0].name, label);
      assigned = false;
      assert.deepEqual((await (await request(users[1], endpoint)).json()).data, []);
    }
  });

  const event = (type, payload) => ({ id: "fixture-event", type, payload, createdAt: new Date().toISOString(), origin: "private-origin" });
  const claims = user => ({ sub: user.id, ...user });
  await t.test("event projection filters customers, employees, favorites and admin-only events", async () => {
    resetRecords();
    for (const type of ["customer.created", "customer.updated"]) {
      assert.equal(await projectEvent(event(type, { record: records[1] }), claims(users[1])), null);
      assert.equal(await projectEvent(event(type, { record: records[1] }), claims(users[3])), null);
      const own = await projectEvent(event(type, { record: records[0] }), claims(users[1]));
      assert.deepEqual(own.payload, {}); assert.equal(own.origin, undefined);
      assert(await projectEvent(event(type, { record: records[1] }), claims(users[0])));
      assert(await projectEvent(event(type, { record: records[1] }), claims(users[4])));
    }
    assert.equal(await projectEvent(event("customer.deleted", { record: records[1] }), claims(users[1])), null);
    assert.deepEqual((await projectEvent(event("customer.deleted", { record: records[0] }), claims(users[1]))).payload, {});
    for (const type of ["lead.created", "lead.updated", "lead.deleted"]) {
      assert.equal(await projectEvent(event(type, { lead: { email: "malice@example.test" } }), claims(users[3])), null);
      assert.deepEqual((await projectEvent(event(type, { lead: { email: users[3].email, notes: "private" } }), claims(users[3]))).payload, {});
    }
    for (const type of ["favorite.created", "favorite.deleted"]) {
      assert.equal(await projectEvent(event(type, { userId: "someone-else" }), claims(users[3])), null);
      assert(await projectEvent(event(type, { userId: users[3].id }), claims(users[3])));
      assert(await projectEvent(event(type, { userId: "someone-else" }), claims(users[0])));
    }
    for (const type of ["user.registered", "inquiry.created"]) {
      assert.equal(await projectEvent(event(type, {}), claims(users[1])), null);
      assert(await projectEvent(event(type, {}), claims(users[0])));
    }
    assert.equal(await projectEvent(event("unrecognized.event", { password: "canary" }), claims(users[0])), null);
    assert.deepEqual((await projectEvent(event("plot.updated", { privateField: "canary" }), claims(users[3]))).payload, {});
  });
  await t.test("authorized tracking projection retains live-map fields and strips everything else", async () => {
    resetRecords();
    const tracking = { customerId: "own", latitude: 1, longitude: 2, status: "ACTIVE", address: "Synthetic", updatedAt: new Date().toISOString(), notes: "private", password: "canary" };
    const projected = await projectEvent(event("tracking.updated", { tracking }), claims(users[3]));
    assert.deepEqual(Object.keys(projected.payload.tracking), ["customerId", "latitude", "longitude", "status", "address", "updatedAt"]);
    assert.equal(await projectEvent(event("tracking.updated", { tracking: { ...tracking, customerId: "other" } }), claims(users[3])), null);
  });

  const openStreams = async (user, signedToken = token(user)) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { headers: { Authorization: `Bearer ${signedToken}`, Accept: "text/event-stream" }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = new TextDecoder().decode((await reader.read()).value);
    const messages = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws`, { headers: { Authorization: `Bearer ${signedToken}` } });
    const connected = new Promise(resolve => ws.on("message", bytes => { const message = JSON.parse(bytes); messages.push(message); if (message.type === "connected") resolve(); }));
    await connected;
    return { reader, ws, messages, controller, readUntil: async id => {
      while (!text.includes(id)) { const chunk = await reader.read(); assert(!chunk.done); text += new TextDecoder().decode(chunk.value); }
      return text;
    } };
  };
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert(Date.now() < deadline, "Timed out waiting for transport"); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  await t.test("SSE and WebSocket both withhold foreign events and sanitize authorized delivery", { timeout: 5000 }, async () => {
    resetRecords();
    const streams = await openStreams(users[1]);
    try {
      const denied = await publishEvent("customer.updated", { record: records[1] });
      const allowed = await publishEvent("customer.updated", { record: records[0], password: "canary" });
      const text = await streams.readUntil(allowed.id);
      await until(() => streams.messages.some(message => message.id === allowed.id));
      assert(!text.includes(denied.id)); assert(!text.includes("Synthetic contact")); assert(!text.includes("canary"));
      assert(!streams.messages.some(message => message.id === denied.id));
      assert.deepEqual(streams.messages.find(message => message.id === allowed.id).payload, {});
    } finally { streams.controller.abort(); streams.ws.terminate(); }
  });
  for (const state of ["deleted", "role changed", "frozen", "relieved", "backend failure", "expired"]) {
    await t.test(`active SSE and WebSocket stop before delivery when session is ${state}`, { timeout: 5000 }, async () => {
      const user = users[1], snapshot = structuredClone(user);
      const streams = await openStreams(user, token(user, state === "expired" ? 1 : 60));
      try {
        if (state === "deleted") user.id = "removed";
        if (state === "role changed") user.role = "CUSTOMER";
        if (state === "frozen") user.employeeProfile = { status: "FROZEN" };
        if (state === "relieved") user.employeeProfile = { status: "ACTIVE", dateOfRelieving: new Date(0) };
        if (state === "backend failure") backendFailure = true;
        if (state === "expired") await new Promise(resolve => setTimeout(resolve, 1100));
        const closed = once(streams.ws, "close");
        const sent = await publishEvent("plot.updated", { plotId: "must-not-arrive" });
        await closed;
        let chunk; do { chunk = await streams.reader.read(); assert(!new TextDecoder().decode(chunk.value).includes(sent.id)); } while (!chunk.done);
        assert(!streams.messages.some(message => message.id === sent.id));
      } finally { backendFailure = false; Object.keys(user).forEach(key => delete user[key]); Object.assign(user, snapshot); streams.controller.abort(); streams.ws.terminate(); }
    });
  }
  await t.test("both transports reject missing or invalid initial authentication", async () => {
    for (const signedToken of [undefined, "invalid"]) {
      assert.equal((await fetch(`${base}/api/stream`, { headers: signedToken ? { Authorization: `Bearer ${signedToken}` } : {} })).status, 401);
      const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws`, { headers: signedToken ? { Authorization: `Bearer ${signedToken}` } : {} });
      const [code] = await once(ws, "close"); assert.equal(code, 1008);
    }
  });
});
