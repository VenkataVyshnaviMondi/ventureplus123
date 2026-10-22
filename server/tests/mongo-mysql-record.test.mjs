import test from "node:test";
import assert from "node:assert/strict";
import { Binary, ObjectId } from "bson";
import { Prisma } from "@prisma/client";
import { convert } from "../scripts/mongo-mysql-record.mjs";

const model = (name) => Prisma.dmmf.datamodel.models.find((entry) => entry.name === name);

test("preserves UUID IDs, password hashes, timestamps and nullable codes", () => {
  const date = new Date("2026-01-01T00:00:00Z");
  const row = convert(model("User"), { _id: "existing-user", email: "a@example.test",
    passwordHash: "existing-hash", displayName: "A", fullName: "A", role: "ADMIN",
    createdAt: date, updatedAt: date });
  assert.equal(row.id, "existing-user");
  assert.equal(row.passwordHash, "existing-hash");
  assert.deepEqual(row.createdAt, date);
  assert.equal(row.employeeId, null);
});

test("preserves BSON IDs, references, and binary upload bytes", () => {
  const id = new ObjectId();
  const bytes = Buffer.from([0, 255, 127, 1]);
  const row = convert(model("VentureAsset"), { _id: id, ventureId: id,
    filename: "image.png", contentType: "image/png", data: new Binary(bytes) });
  assert.equal(row.id, id.toHexString());
  assert.equal(row.ventureId, id.toHexString());
  assert.deepEqual(row.data, bytes);
});

test("preserves JSON assignment lists and maps absent nullable JSON to SQL NULL", () => {
  const assignment = convert(model("EmployeeAssignment"), { _id: "a", userId: "u",
    assignedLocationIds: ["l"], assignedVentureIds: ["v"], updatedAt: new Date() });
  assert.deepEqual(assignment.assignedLocationIds, ["l"]);
  const profile = convert(model("EmployeeProfile"), { _id: "p", userId: "u", updatedAt: new Date() });
  assert.equal(profile.achievements, Prisma.DbNull);
});

test("rejects unknown fields, missing IDs, invalid dates and null required fields", () => {
  assert.throws(() => convert(model("Location"), { _id: "l", name: "L", legacy: true }), /unmapped fields/);
  assert.throws(() => convert(model("Location"), { name: "L" }), /required field missing/);
  assert.throws(() => convert(model("Location"), { _id: "l", name: "L", createdAt: "bad" }), /invalid date/);
  assert.throws(() => convert(model("Location"), { _id: "l", name: null }), /required field is null/);
});
