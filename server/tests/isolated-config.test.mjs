import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { createRequire } from "node:module";
import { isolatedConfig, withIsolatedDatabase } from "./isolated-config.mjs";
import { enterRuntime } from "./isolated-runtime.mjs";

const target = { host: "127.0.0.1", port: 3307, database: "venture_test", username: "venture_runner", accountHost: "localhost",
  serverUuid: "00000000-0000-4000-8000-000000000001" };
const policy = { version: 1, productionHosts: ["production.example.test", "192.0.2.1"], targets: [target] };
const environment = { VENTURE_TEST_DB_APPROVED: "yes", DATABASE_URL: "mysql://venture_runner:fixture@127.0.0.1:3307/venture_test",
  VENTURE_TEST_DATABASE: "venture_test", JWT_SECRET: "x".repeat(32), VENTURE_APP_CHECKOUT: path.resolve("fixture-app"),
  VENTURE_TEST_POLICY_FILE: path.resolve("fixture-policy.json") };
const principal = "`venture_runner`@`localhost`";
const grant = `GRANT SELECT, INSERT, UPDATE, DELETE ON \`venture\\_test\`.* TO ${principal}`;
const identity = { databaseName: target.database, currentUser: "venture_runner@localhost", loginUser: "venture_runner@127.0.0.1", serverUuid: target.serverUuid };
const rows = statements => statements.map(statement => ({ Grant: statement }));

// No real Prisma/app imports are used. Every metadata read and write is a fake.
function fixture(options = {}) {
  const calls = { runtime: 0, imports: 0, reads: 0, writes: 0, disconnects: 0, restores: 0 };
  const prisma = {
    $queryRawUnsafe: async sql => {
      calls.reads++;
      if (options.queryFailure) throw new Error("Fixture metadata unavailable");
      if (sql.startsWith("SELECT DATABASE()")) return options.identity ?? [identity];
      assert.equal(sql, "SHOW GRANTS FOR CURRENT_USER()");
      if (options.grantFailure) throw new Error("Fixture grants unavailable");
      return options.grants ?? rows([grant]);
    },
    user: { create: async () => { calls.writes++; return { id: "fixture-user" }; } },
    $disconnect: async () => { calls.disconnects++; if (options.disconnectFailure) throw new Error("Fixture disconnect failure"); }
  };
  return { calls, adapters: {
    execArgv: options.execArgv ?? [],
    readPolicy: async () => { if (options.readFailure) throw new Error("Fixture policy unavailable"); return options.policyText ?? JSON.stringify(options.policy ?? policy); },
    enterRuntime: async () => { calls.runtime++; if (options.runtimeFailure) throw new Error("Fixture runtime setup failure"); return () => { calls.restores++; }; },
    loadPrisma: async () => { calls.imports++; if (options.importFailure) throw new Error("Fixture import failure"); return prisma; }
  }, work: async ({ prisma }) => { await prisma.user.create(); return "fixture-success"; } };
}

test("integration isolation gate (all network APIs trapped; database adapters mocked)", async t => {
  let networkCalls = 0;
  const denyNetwork = () => { networkCalls++; throw new Error("Network is forbidden in isolation regression tests"); };
  for (const [object, names] of [[net, ["connect", "createConnection"]], [net.Socket.prototype, ["connect"]],
    [tls, ["connect"]], [http, ["request", "get", "createServer"]], [https, ["request", "get", "createServer"]],
    [dns, ["lookup", "resolve", "resolve4", "resolve6"]], [dns.promises, ["lookup", "resolve", "resolve4", "resolve6"]], [dgram, ["createSocket"]]]) {
    for (const name of names) mock.method(object, name, denyNetwork);
  }
  mock.method(globalThis, "fetch", denyNetwork);
  t.after(() => { mock.restoreAll(); assert.equal(networkCalls, 0); });

  const invalidEnvironment = [
    ["approval missing", { VENTURE_TEST_DB_APPROVED: undefined }],
    ["URL missing", { DATABASE_URL: undefined }], ["malformed URL", { DATABASE_URL: "bad-url" }],
    ["unsupported protocol", { DATABASE_URL: "postgresql://venture_runner:fixture@127.0.0.1:3307/venture_test" }],
    ["production host", { DATABASE_URL: "mysql://venture_runner:fixture@production.example.test:3307/venture_test" }],
    ["unknown host", { DATABASE_URL: "mysql://venture_runner:fixture@unknown.example.test:3307/venture_test" }],
    ["wrong port", { DATABASE_URL: "mysql://venture_runner:fixture@127.0.0.1:3306/venture_test" }],
    ["wrong schema", { DATABASE_URL: "mysql://venture_runner:fixture@127.0.0.1:3307/another_test" }],
    ["wrong username", { DATABASE_URL: "mysql://other:fixture@127.0.0.1:3307/venture_test" }],
    ["root account", { DATABASE_URL: "mysql://root:fixture@127.0.0.1:3307/venture_test" }],
    ["password missing", { DATABASE_URL: "mysql://venture_runner@127.0.0.1:3307/venture_test" }],
    ["encoded schema", { DATABASE_URL: "mysql://venture_runner:fixture@127.0.0.1:3307/%76enture_test" }],
    ["username control encoding", { DATABASE_URL: "mysql://venture_runner%00:fixture@127.0.0.1:3307/venture_test" }],
    ["connection overrides", { DATABASE_URL: `${environment.DATABASE_URL}?socket=/tmp/mysql` }],
    ["empty query suffix", { DATABASE_URL: `${environment.DATABASE_URL}?` }],
    ["URL fragment", { DATABASE_URL: `${environment.DATABASE_URL}#ignored` }],
    ["wrong database confirmation", { VENTURE_TEST_DATABASE: "other_test" }],
    ["missing JWT secret", { JWT_SECRET: undefined }], ["short JWT secret", { JWT_SECRET: "short" }],
    ["relative app path", { VENTURE_APP_CHECKOUT: "relative" }], ["network app path", { VENTURE_APP_CHECKOUT: "//network/app" }],
    ["missing policy path", { VENTURE_TEST_POLICY_FILE: undefined }], ["relative policy path", { VENTURE_TEST_POLICY_FILE: "relative.json" }],
    ["network policy path", { VENTURE_TEST_POLICY_FILE: "//network/policy.json" }],
    ["production Redis", { REALTIME_REDIS_URL: "redis://production.example.test:6379" }],
    ["Redis alias", { REDIS_URL: "redis://production.example.test:6379" }],
    ["mixed-case Redis", { Realtime_Redis_Url: "redis://production.example.test:6379" }],
    ["dotenv path", { DOTENV_CONFIG_PATH: ".env.production" }], ["dotenv override", { DOTENV_CONFIG_OVERRIDE: "true" }],
    ["dotenv key", { DOTENV_KEY: "fixture" }], ["Node preload", { NODE_OPTIONS: "--require=dotenv/config" }],
    ["Node path", { NODE_PATH: "untrusted-modules" }], ["Prisma engine override", { PRISMA_QUERY_ENGINE_BINARY: "untrusted-engine" }]
  ];
  for (const [label, override] of invalidEnvironment) await t.test(`preflight rejects ${label} without imports, network or writes`, async () => {
    const f = fixture();
    await assert.rejects(withIsolatedDatabase({ ...environment, ...override }, f.adapters, f.work));
    assert.deepEqual(f.calls, { runtime: 0, imports: 0, reads: 0, writes: 0, disconnects: 0, restores: 0 });
    assert.equal(networkCalls, 0);
  });
  const invalidPolicies = [undefined, {}, { ...policy, version: 2 }, { ...policy, productionHosts: [] },
    { ...policy, productionHosts: ["127.0.0.1"] }, { ...policy, productionHosts: ["127.0.0.1."] },
    { ...policy, targets: [] }, { ...policy, targets: [target, target] },
    ...[{ port: "3307" }, { port: 0 }, { username: "root" }, { database: "production" }, { accountHost: "bad@host" },
      { serverUuid: undefined }, { host: "127.1" }, { host: "2130706433" }, { host: "0x7f000001" }]
      .map(override => ({ ...policy, targets: [{ ...target, ...override }] }))];
  for (const [index, badPolicy] of invalidPolicies.entries()) await t.test(`rejects invalid/ambiguous allowlist ${index + 1} before client import`, async () => {
    const f = fixture({ policyText: JSON.stringify(badPolicy) ?? "null" });
    await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.imports, 0); assert.equal(f.calls.writes, 0); assert.equal(networkCalls, 0);
  });
  for (const options of [{ policyText: "{broken-json" }, { readFailure: true },
    ...["-r", "-rpoison", "--require=dotenv/config", "--import=poison", "--env-file=.env.production", "--loader=poison"].map(arg => ({ execArgv: [arg] }))]) {
    await t.test("policy/preload failure cannot reach a database adapter", async () => {
      const f = fixture(options); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
      assert.equal(f.calls.imports, 0); assert.equal(f.calls.writes, 0);
    });
  }

  const badIdentities = [[], [identity, identity], [{ ...identity, databaseName: "production" }],
    [{ ...identity, currentUser: "root@localhost" }], [{ ...identity, currentUser: "venture_runner@%" }],
    [{ ...identity, loginUser: "other@localhost" }], [{ ...identity, serverUuid: "another-server" }], [{}]];
  for (const [index, badIdentity] of badIdentities.entries()) await t.test(`runtime identity failure ${index + 1} blocks work and restores runtime`, async () => {
    const f = fixture({ identity: badIdentity }); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.reads, 1); assert.equal(f.calls.writes, 0); assert.equal(f.calls.disconnects, 1); assert.equal(f.calls.restores, 1);
  });
  const unsafeGrants = [[], [{}], [{ Grant: grant, extra: "unexpected" }], [{ Grant: 42 }],
    ...[
      `GRANT ALL PRIVILEGES ON \`venture\\_test\`.* TO ${principal}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON *.* TO ${principal}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`production\`.* TO ${principal}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`venture_test\`.* TO ${principal}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`venture%test\`.* TO ${principal}`,
      `${grant} WITH GRANT OPTION`, `${grant} WITH ADMIN OPTION`, `${grant}; GRANT ALL ON *.* TO ${principal}`,
      `GRANT USAGE ON *.* TO ${principal} WITH GRANT OPTION`, `GRANT role TO ${principal}`,
      `GRANT PROXY ON root@localhost TO ${principal}`, grant.replace("DELETE", "DROP"), grant.replace("DELETE", "CREATE"),
      grant.replace("DELETE", "TRIGGER"), grant.replace("DELETE", "SELECT"), grant.replace(".*", ".`User`"),
      grant.replace(principal, "`another`@`localhost`"), `GRANT SELECT ON \`venture\\_test\`.* TO ${principal}`,
      `GRANT USAGE ON *.* TO ${principal}`
    ].map(statement => rows([statement]))];
  for (const [index, grants] of unsafeGrants.entries()) await t.test(`unsafe or ambiguous grants ${index + 1} prevent writes`, async () => {
    const f = fixture({ grants }); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.reads, 2); assert.equal(f.calls.writes, 0); assert.equal(f.calls.disconnects, 1); assert.equal(f.calls.restores, 1);
  });
  await t.test("unavailable metadata fails closed without application work", async () => {
    const f = fixture({ queryFailure: true }); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.writes, 0); assert.equal(f.calls.restores, 1);
  });
  await t.test("unavailable grants metadata cannot reach the work callback", async () => {
    const f = fixture({ grantFailure: true }); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.reads, 2); assert.equal(f.calls.writes, 0); assert.equal(f.calls.restores, 1);
  });
  await t.test("runtime setup failure never imports Prisma", async () => {
    const f = fixture({ runtimeFailure: true }); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.imports, 0); assert.equal(f.calls.writes, 0);
  });
  await t.test("Prisma import failure restores the sanitized runtime without writes", async () => {
    const f = fixture({ importFailure: true }); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.writes, 0); assert.equal(f.calls.restores, 1);
  });
  await t.test("disconnect failure still restores runtime and prevents a successful result", async () => {
    const f = fixture({ disconnectFailure: true }); await assert.rejects(withIsolatedDatabase(environment, f.adapters, f.work));
    assert.equal(f.calls.restores, 1);
  });
  await t.test("host, port, schema and account must match the same allowlist tuple", async () => {
    const second = { ...target, host: "db2.example.test", username: "second_runner" };
    const f = fixture({ policy: { ...policy, targets: [target, second] } });
    await assert.rejects(withIsolatedDatabase({ ...environment, DATABASE_URL: "mysql://venture_runner:fixture@db2.example.test:3307/venture_test" }, f.adapters, f.work));
    assert.equal(f.calls.imports, 0); assert.equal(f.calls.writes, 0);
  });
  await t.test("approved default port, canonical IPv6 and encoded username retain safe acceptance", () => {
    const defaultPort = { ...policy, targets: [{ ...target, port: 3306 }] };
    assert.equal(isolatedConfig({ ...environment, DATABASE_URL: "mysql://venture%5Frunner:fixture@127.0.0.1/venture_test" }, defaultPort).port, 3306);
    const ipv6 = { ...policy, targets: [{ ...target, host: "::1" }] };
    assert.equal(isolatedConfig({ ...environment, DATABASE_URL: "mysql://venture_runner:fixture@[0:0:0:0:0:0:0:1]:3307/venture_test" }, ipv6).host, "::1");
  });
  await t.test("separate exact CRUD grants preserve legitimate account compatibility", async () => {
    const f = fixture({ grants: rows(["SELECT", "INSERT", "UPDATE", "DELETE"].map(privilege => `GRANT ${privilege} ON \`venture\\_test\`.* TO ${principal}`)) });
    assert.equal(await withIsolatedDatabase(environment, f.adapters, f.work), "fixture-success");
    assert.equal(f.calls.writes, 1);
  });
  await t.test("approved tuple, authenticated identity and exact CRUD grants permit the fake work control", async () => {
    const f = fixture({ grants: rows([`GRANT USAGE ON *.* TO ${principal}`, grant]) });
    assert.equal(await withIsolatedDatabase(environment, f.adapters, f.work), "fixture-success");
    assert.deepEqual(f.calls, { runtime: 1, imports: 1, reads: 2, writes: 1, disconnects: 1, restores: 1 });
    assert.equal(networkCalls, 0);
  });
  await t.test("work errors still disconnect and restore the runtime", async () => {
    const f = fixture(); await assert.rejects(withIsolatedDatabase(environment, f.adapters, async () => { throw new Error("Fixture work failure"); }));
    assert.equal(f.calls.disconnects, 1); assert.equal(f.calls.restores, 1);
  });
  await t.test("empty cwd and explicit app environment prevent dotenv from restoring production service settings", () => {
    const original = fs.mkdtempSync(path.join(os.tmpdir(), "venture-dotenv-fixture-"));
    fs.writeFileSync(path.join(original, ".env"), "REALTIME_REDIS_URL=redis://production.example.test:6379\nCOOKIE_DOMAIN=production.example.test\n");
    const runtime = { env: { ...environment, PATH: process.env.PATH, COOKIE_DOMAIN: "production.example.test", UNRELATED_SECRET: "fixture" },
      cwd: () => cwd, chdir: directory => { cwd = directory; } };
    let cwd = original;
    const previous = { ...runtime.env };
    const restore = enterRuntime(isolatedConfig(environment, policy), runtime);
    const temporary = runtime.cwd();
    try {
      assert.notEqual(temporary, original); assert.deepEqual(fs.readdirSync(temporary), []);
      assert.equal(runtime.env.REALTIME_REDIS_URL, ""); assert.equal(runtime.env.COOKIE_DOMAIN, "");
      assert.equal(runtime.env.DATABASE_URL, environment.DATABASE_URL); assert.equal(runtime.env.NODE_ENV, "production");
      assert.equal(runtime.env.UNRELATED_SECRET, undefined);
      const dotenv = createRequire(import.meta.url)("dotenv");
      const result = dotenv.config({ path: path.join(temporary, ".env"), processEnv: runtime.env });
      assert.equal(result.error?.code, "ENOENT"); assert.equal(runtime.env.REALTIME_REDIS_URL, "");
    } finally { restore(); fs.unlinkSync(path.join(original, ".env")); fs.rmdirSync(original); }
    assert.equal(fs.existsSync(temporary), false); assert.equal(runtime.cwd(), original); assert.deepEqual(runtime.env, previous);
  });
});
