import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { rootCertificates } from "node:tls";
import { runInNewContext } from "node:vm";
import { prepareDatabaseUrl, TIDB_CA_PATH, writeCertificateAtomically } from "../dist/config/tidb-tls.js";

// Public trust-store data already shipped with Node. No private key, downloaded
// TiDB CA, real password or production configuration is used here. The approved
// account name is non-secret; all passwords are fictional and no connection is made.
const certificate = rootCertificates.map(pem => new X509Certificate(pem)).find(cert =>
  cert.ca && cert.subject === cert.issuer && cert.verify(cert.publicKey)
  && Date.parse(cert.validFrom) < Date.now() && Date.now() < Date.parse(cert.validTo));
assert(certificate, "Node must provide a currently valid public CA for this offline test");
const pem = certificate.toString().trim() + "\n";
const encoded = Buffer.from(pem).toString("base64");
const username = "2K37DPjU76qJR1z.vp_runtime";
const password = "fictional-password-only";
const databaseUrl = `mysql://${username}:${password}@gateway01.ap-northeast-1.prod.aws.tidbcloud.com:4000/ventureplus_staging`;
const settings = { vercelEnv: "preview", caBase64: encoded, stagingDbUser: username };
const prismaSource = fs.readFileSync(new URL("../dist/config/prisma.js", import.meta.url), "utf8");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "ventureplus-tls-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert(path.basename(directory).startsWith("ventureplus-tls-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function rejectsBeforeWrite(url, overrides, message) {
  let writes = 0;
  assert.throws(() => prepareDatabaseUrl(url, { ...settings, ...overrides }, () => { writes++; }), error => {
    assert.match(error.message, message);
    for (const secret of [username, password, encoded, pem, url]) {
      assert(!error.message.includes(secret), "configuration error must omit sensitive input");
    }
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(writes, 0);
}

test("valid CA is installed and strict TLS is enforced without changing credentials", () => {
  const written = [];
  const url = new URL(prepareDatabaseUrl(databaseUrl + "?connection_limit=2&pool_timeout=10", settings,
    value => written.push(value)));
  assert.deepEqual(written, [pem]);
  assert.equal(url.username, username);
  assert.equal(url.password, password);
  assert.equal(url.searchParams.get("sslaccept"), "strict");
  assert.equal(url.searchParams.get("sslcert"), "/tmp/tidb-ca.pem");
  assert.equal(url.searchParams.get("connection_limit"), "2");
  assert.equal(url.searchParams.get("pool_timeout"), "10");
});

test("correct existing TLS options and URL-encoded password are preserved", () => {
  const value = databaseUrl.replace(password, "fictional%40p%3Ass%2Fword%3F%23%25%2B")
    + "?sslaccept=strict&sslcert=%2Ftmp%2Ftidb-ca.pem";
  assert.equal(prepareDatabaseUrl(value, settings, () => {}), value);
});

for (const missing of [undefined, "", "   "]) {
  test(`missing or empty certificate fails closed (${JSON.stringify(missing)})`, () => {
    rejectsBeforeWrite(databaseUrl, { caBase64: missing }, /CA certificate|TIDB_CA_CERT_BASE64/);
  });
}

const invalidCertificates = {
  "malformed base64": "not!base64",
  "oversized input": "A".repeat(65537),
  "non-PEM content": Buffer.from("fixture-private-value").toString("base64"),
  "invalid DER": Buffer.from("-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n").toString("base64"),
  "extra text": Buffer.from(pem + "fixture-private-value").toString("base64"),
  "multiple certificates": Buffer.from(pem + pem).toString("base64"),
  "private key marker": Buffer.from(pem + "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----").toString("base64"),
  "DER trailing bytes": Buffer.from(`-----BEGIN CERTIFICATE-----\n${Buffer.concat([certificate.raw, Buffer.from("junk")]).toString("base64")}\n-----END CERTIFICATE-----\n`).toString("base64")
};
for (const [name, caBase64] of Object.entries(invalidCertificates)) {
  test(`rejects ${name}`, () => rejectsBeforeWrite(databaseUrl, { caBase64 }, /invalid CA certificate/));
}

test("rejects expired and not-yet-valid certificates", t => {
  const clock = t.mock.method(Date, "now", () => Date.parse(certificate.validFrom) - 1);
  rejectsBeforeWrite(databaseUrl, {}, /invalid CA certificate/);
  clock.mock.mockImplementation(() => Date.parse(certificate.validTo));
  rejectsBeforeWrite(databaseUrl, {}, /invalid CA certificate/);
});

test("requires the CA basic constraint", () => {
  // Toggle the public fixture's CA Boolean (same DER length) to exercise this
  // validation independently of certificate parsing. This is not a usable cert.
  const marker = Buffer.from("0603551d13", "hex");
  const raw = Buffer.from(certificate.raw);
  const extension = raw.indexOf(marker);
  const caFlag = raw.indexOf(Buffer.from("0101ff", "hex"), extension + marker.length + 3);
  assert(extension >= 0 && caFlag >= 0 && caFlag < extension + 25);
  raw[caFlag + 2] = 0;
  const modified = new X509Certificate(raw);
  assert.equal(modified.ca, false);
  rejectsBeforeWrite(databaseUrl, { caBase64: Buffer.from(modified.toString()).toString("base64") }, /invalid CA certificate/);
});

test("rejects a corrupted self-signed CA signature", () => {
  const raw = Buffer.from(certificate.raw);
  raw[raw.length - 1] ^= 1;
  const modified = new X509Certificate(raw);
  assert.equal(modified.ca, true);
  assert.equal(modified.verify(modified.publicKey), false);
  rejectsBeforeWrite(databaseUrl, { caBase64: Buffer.from(modified.toString()).toString("base64") }, /invalid CA certificate/);
});

const wrongTargets = {
  "production database": databaseUrl.replace("/ventureplus_staging", "/ventureplus_production"),
  "different host": databaseUrl.replace("gateway01.ap-northeast-1.prod.aws.tidbcloud.com", "production.example.invalid"),
  "host suffix attack": databaseUrl.replace(".com:", ".com.attacker.invalid:"),
  "wrong port": databaseUrl.replace(":4000/", ":3306/"),
  "missing port": databaseUrl.replace(":4000/", "/"),
  "wrong protocol": databaseUrl.replace("mysql:", "postgresql:"),
  "missing credentials": databaseUrl.replace(`${username}:${password}@`, ""),
  "missing password": databaseUrl.replace(`:${password}`, ""),
  "fragment": databaseUrl + "#sslaccept=strict",
  "trailing slash": databaseUrl + "/",
  "encoded database": databaseUrl.replace("/ventureplus", "/%76entureplus"),
  "control characters": databaseUrl + "\n",
  "malformed URL": "mysql://[invalid"
};
for (const [name, url] of Object.entries(wrongTargets)) {
  test(`rejects ${name}`, () => rejectsBeforeWrite(url, {}, /approved staging database/));
}

test("requires the independently configured exact staging account", () => {
  for (const stagingDbUser of [undefined, "", "root", "cluster.root", " " + username, username + "\n"]) {
    rejectsBeforeWrite(databaseUrl, { stagingDbUser }, /TIDB_STAGING_DB_USER/);
  }
  rejectsBeforeWrite(databaseUrl.replace(username, "anothercluster.production_user"), {}, /credentials do not match/);
  rejectsBeforeWrite(databaseUrl.replace(password, "%ZZ"), {}, /credentials do not match/);
});

test("rejects incorrect runtime usernames even when both settings match", () => {
  for (const stagingDbUser of ["2K37DPjU76qJR1z.other_runtime", "othercluster.vp_runtime", username.toLowerCase()]) {
    rejectsBeforeWrite(databaseUrl, { stagingDbUser }, /TIDB_STAGING_DB_USER/);
    rejectsBeforeWrite(databaseUrl.replace(username, stagingDbUser), { stagingDbUser }, /TIDB_STAGING_DB_USER/);
    rejectsBeforeWrite(databaseUrl.replace(username, stagingDbUser), {}, /credentials do not match/);
  }
});

test("explicitly rejects the migrator account in either or both settings", () => {
  const stagingDbUser = "2K37DPjU76qJR1z.vp_migrator";
  rejectsBeforeWrite(databaseUrl, { stagingDbUser }, /must not use the migrator account/);
  rejectsBeforeWrite(databaseUrl.replace(username, stagingDbUser), { stagingDbUser }, /must not use the migrator account/);
  rejectsBeforeWrite(databaseUrl.replace(username, stagingDbUser), {}, /credentials do not match/);
  rejectsBeforeWrite(databaseUrl.replace(username, "2K37DPjU76qJR1z.%76p_migrator"), {}, /credentials do not match/);
});

test("rejects root accounts in either or both settings, including case variants", () => {
  for (const stagingDbUser of ["root", "ROOT", "2K37DPjU76qJR1z.root", "2K37DPjU76qJR1z.ROOT"]) {
    rejectsBeforeWrite(databaseUrl, { stagingDbUser }, /TIDB_STAGING_DB_USER/);
    rejectsBeforeWrite(databaseUrl.replace(username, stagingDbUser), { stagingDbUser }, /TIDB_STAGING_DB_USER/);
    rejectsBeforeWrite(databaseUrl.replace(username, stagingDbUser), {}, /credentials do not match/);
  }
});

for (const query of [
  "sslaccept=accept_invalid_certs", "sslaccept=typo", "sslcert=/other/ca.pem",
  "sslaccept=strict&sslaccept=strict", "sslcert=%2Ftmp%2Ftidb-ca.pem&sslcert=other",
  "socket=/tmp/mysql.sock", "prefer_socket=true", "sslidentity=/secret/key.p12",
  "sslpassword=secret", "unknown=secret", "pool_timeout=-1", "connection_limit=2&connection_limit=3"
]) {
  test(`rejects unsafe/duplicate option ${query.split("=")[0]} (${query.length})`, () => {
    rejectsBeforeWrite(databaseUrl + "?" + query, {}, /unsafe DATABASE_URL option|duplicate DATABASE_URL option/);
  });
}

test("ordinary production and local database URLs are untouched and write no files", () => {
  const existing = "mysql://fixture:fixture@localhost:3306/existing?connection_limit=3";
  for (const vercelEnv of [undefined, "production", "development"]) {
    assert.equal(prepareDatabaseUrl(existing, { vercelEnv }, () => assert.fail("must not write")), existing);
  }
});

test("preview cannot fall back to an existing non-staging connection", () => {
  rejectsBeforeWrite("mysql://fixture:fixture@localhost:3306/existing", { caBase64: undefined }, /approved staging database/);
});

test("staging configuration cannot be used in production", () => {
  rejectsBeforeWrite(databaseUrl, { vercelEnv: "production" }, /not allowed in production/);
});

test("staging database name and either staging variable trigger validation outside Preview", () => {
  rejectsBeforeWrite(databaseUrl, { vercelEnv: undefined, caBase64: undefined, stagingDbUser: undefined }, /TIDB_STAGING_DB_USER/);
  for (const config of [{ caBase64: encoded }, { stagingDbUser: username }]) {
    assert.throws(() => prepareDatabaseUrl("mysql://fixture:fixture@localhost:3306/existing", config,
      () => assert.fail("must not write")), /approved staging database/);
  }
});

test("atomic installation keeps the old file until rename, leaves only the new file", t => {
  const directory = temporaryDirectory(t);
  const destination = path.join(directory, "tidb-ca.pem");
  fs.writeFileSync(destination, "previous file");
  const originalRename = fs.renameSync;
  let renames = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    assert.equal(to, destination);
    assert.equal(path.dirname(from), directory);
    assert.equal(fs.readFileSync(destination, "utf8"), "previous file");
    assert.equal(fs.readFileSync(from, "utf8"), pem);
    renames++;
    return originalRename(from, to);
  });
  writeCertificateAtomically(pem, destination);
  assert.equal(renames, 1);
  assert.equal(fs.readFileSync(destination, "utf8"), pem);
  assert.deepEqual(fs.readdirSync(directory), ["tidb-ca.pem"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});

test("failed rename preserves the existing file, cleans temporary file, and redacts filesystem errors", t => {
  const directory = temporaryDirectory(t);
  const destination = path.join(directory, "tidb-ca.pem");
  fs.writeFileSync(destination, "previous file");
  t.mock.method(fs, "renameSync", () => { throw new Error(`${password} ${encoded} ${destination}`); });
  assert.throws(() => writeCertificateAtomically(pem, destination), error => {
    assert.equal(error.message, "TiDB staging TLS configuration rejected: unable to install CA certificate");
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(fs.readFileSync(destination, "utf8"), "previous file");
  assert.deepEqual(fs.readdirSync(directory), ["tidb-ca.pem"]);
});

test("failed write aborts without exposing underlying details", t => {
  const directory = temporaryDirectory(t);
  t.mock.method(fs, "writeFileSync", () => { throw new Error(`${password} ${encoded}`); });
  assert.throws(() => writeCertificateAtomically(pem, path.join(directory, "tidb-ca.pem")),
    { message: "TiDB staging TLS configuration rejected: unable to install CA certificate" });
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.throws(() => prepareDatabaseUrl(databaseUrl, settings, () => { throw new Error(password); }),
    { message: "TiDB staging TLS configuration rejected: unable to install CA certificate" });
});

test("exclusive creation failure never removes a file it does not own", t => {
  const directory = temporaryDirectory(t);
  let cleanups = 0;
  t.mock.method(fs, "openSync", () => { throw new Error("exclusive create failed"); });
  t.mock.method(fs, "unlinkSync", () => { cleanups++; });
  assert.throws(() => writeCertificateAtomically(pem, path.join(directory, "tidb-ca.pem")),
    /unable to install CA certificate/);
  assert.equal(cleanups, 0);
});

function initializePrisma(config, installCertificate, constructed) {
  runInNewContext(prismaSource, {
    exports: {},
    process: { env: {
      VERCEL_ENV: config.vercelEnv, TIDB_CA_CERT_BASE64: config.caBase64,
      TIDB_STAGING_DB_USER: config.stagingDbUser
    }, on() {} },
    require(specifier) {
      if (specifier === "@prisma/client") return { PrismaClient: class { constructor(options) { constructed(options); } } };
      if (specifier === "./env.js") return { env: { databaseUrl, nodeEnv: "production" } };
      if (specifier === "./logger.js") return { logger: { error() { assert.fail("must not log"); } } };
      if (specifier === "./tidb-tls.js") return {
        prepareDatabaseUrl: (url, value) => prepareDatabaseUrl(url, value, installCertificate)
      };
      assert.fail(`Unexpected dependency: ${specifier}`);
    }
  });
}

test("Prisma construction follows completed CA installation even with NODE_ENV=production", t => {
  const destination = path.join(temporaryDirectory(t), "tidb-ca.pem");
  let constructed = 0;
  initializePrisma(settings, value => writeCertificateAtomically(value, destination), options => {
    assert.equal(fs.readFileSync(destination, "utf8"), pem);
    const url = new URL(options.datasources.db.url);
    assert.equal(url.searchParams.get("sslcert"), TIDB_CA_PATH);
    assert.equal(url.searchParams.get("sslaccept"), "strict");
    constructed++;
  });
  assert.equal(constructed, 1);
});

test("missing/invalid certificates and failed writes prevent Prisma construction, even with an old CA", t => {
  const destination = path.join(temporaryDirectory(t), "tidb-ca.pem");
  fs.writeFileSync(destination, pem);
  for (const caBase64 of [undefined, "invalid"]) {
    assert.throws(() => initializePrisma({ ...settings, caBase64 }, () => assert.fail("must not write"),
      () => assert.fail("must not initialize Prisma")), /CA certificate|TIDB_CA_CERT_BASE64/);
  }
  assert.throws(() => initializePrisma(settings, () => { throw new Error(password); },
    () => assert.fail("must not initialize Prisma")), /unable to install CA certificate/);
  assert.equal(fs.readFileSync(destination, "utf8"), pem);
});
