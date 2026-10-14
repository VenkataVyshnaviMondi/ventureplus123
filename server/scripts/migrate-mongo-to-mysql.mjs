import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import { convert } from "./mongo-mysql-record.mjs";
import { Prisma, PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readEnv = (file) => fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
const sourceEnv = readEnv(path.resolve(root, process.env.MONGO_SOURCE_ENV_FILE || "backend/.env"));
const targetEnv = readEnv(path.resolve(root, process.env.MYSQL_TARGET_ENV_FILE || "server/.env"));
const sourceUrl = process.env.MONGO_SOURCE_URL || sourceEnv.MONGO_SOURCE_URL || sourceEnv.MONGODB_URI;
const targetUrl = process.env.MYSQL_TARGET_URL || targetEnv.DATABASE_URL;
assert(/^mongodb(?:\+srv)?:\/\//.test(sourceUrl || ""), "Configure MONGO_SOURCE_URL or MONGO_SOURCE_ENV_FILE");
assert(/^mysql:\/\//.test(targetUrl || ""), "Configure MYSQL_TARGET_URL or MYSQL_TARGET_ENV_FILE");

// Reuse the legacy backend's installed driver; never connect through its models.
const backendRequire = createRequire(path.join(root, "backend/package.json"));
const { MongoClient } = backendRequire("mongodb");
const source = new MongoClient(sourceUrl, { serverSelectionTimeoutMS: 5000 });
const target = new PrismaClient({ datasources: { db: { url: targetUrl } } });
const order = ["User", "Location", "CustomerRecord", "Venture", "Plot", "EmployeeProfile",
  "AgentProfile", "EmployeeAssignment", "VentureAsset", "Lead", "Favorite", "Inquiry", "TrackingUpdate", "OtpRequest"];
const models = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));
const delegate = (name) => name[0].toLowerCase() + name.slice(1);


let phase = "connection check";
try {
  const connections = await Promise.allSettled([source.connect(), target.$connect()]);
  const failures = connections.flatMap((result, i) => result.status === "rejected"
    ? [`${i === 0 ? "MongoDB source" : "MySQL destination"} unavailable (${result.reason?.code || result.reason?.name || "connection error"})`] : []);
  assert(!failures.length, failures.join("; "));
  phase = "source inspection";
  const database = source.db();
  const collections = await database.listCollections({}, { nameOnly: true }).toArray();
  const known = new Set(order.map((name) => models.get(name).dbName || name));
  let unsupported = false;
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    const count = await database.collection(name).countDocuments();
    console.log(`Source ${name}: ${count} records${known.has(name) ? "" : " (unmapped collection)"}`);
    if (count && !known.has(name)) unsupported = true;
  }
  assert(!unsupported, "Source contains legacy/unmapped collections. Define their field mappings before importing; no records were written.");
  const snapshot = new Map();
  for (const name of order) {
    const model = models.get(name);
    const docs = await database.collection(model.dbName || name).find().toArray();
    snapshot.set(name, docs.map((doc) => convert(model, doc)));
  }
  assert([...snapshot.values()].some((rows) => rows.length), "Source database contains no application records");
  phase = "destination inspection";
  for (const name of order) {
    assert(await target[delegate(name)].count() === 0, `Destination ${name} is not empty. Refusing to overwrite or merge records.`);
  }
  console.log("Preflight passed. Source must remain unchanged from this point through verification.");
  if (!process.argv.includes("--apply")) {
    console.log("Dry run only. Stop source application writes, then rerun with --apply to import.");
  } else {
    phase = "transactional import";
    await target.$transaction(async (tx) => {
      for (const name of order) {
        const table = tx[delegate(name)];
        assert(await table.count() === 0, `Destination ${name} changed after preflight`);
        const rows = snapshot.get(name);
        for (const row of rows) {
          await table.create({ data: row });
          const stored = await table.findUniqueOrThrow({ where: { id: row.id } });
          for (const [key, value] of Object.entries(row)) {
            assert.deepEqual(stored[key], value === Prisma.DbNull ? null : value, `${name}.${key}: verification mismatch`);
          }
        }
        assert.equal(await table.count(), rows.length, `${name}: count mismatch`);
        console.log(`Verified ${name}: ${rows.length} records`);
      }
      // Abort rather than committing a snapshot that changed during the import.
      for (const name of order) {
        const model = models.get(name);
        const current = (await database.collection(model.dbName || name).find().toArray())
          .map((doc) => convert(model, doc)).sort((a, b) => a.id.localeCompare(b.id));
        const original = [...snapshot.get(name)].sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(current, original, `${name}: source changed during import; retry with source writes stopped`);
      }
    }, { maxWait: 10000, timeout: 600000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    console.log("Migration committed. IDs, passwords, timestamps, JSON and binary files verified. MongoDB was not modified.");
  }
} catch (error) {
  // Connection and Prisma error messages can contain credentials or record data.
  const safeMessage = error instanceof assert.AssertionError ? error.message
    : error?.code ? `Database error ${error.code}` : error?.name || "Migration error";
  console.error(`Stopped during ${phase}: ${safeMessage}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([source.close(), target.$disconnect()]);
}
