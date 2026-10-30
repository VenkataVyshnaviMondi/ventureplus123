import { randomUUID, X509Certificate } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export const TIDB_CA_PATH = "/tmp/tidb-ca.pem";
const STAGING_HOST = "gateway01.ap-northeast-1.prod.aws.tidbcloud.com";
const STAGING_DATABASE = "/ventureplus_staging";
const STAGING_RUNTIME_USER = "2K37DPjU76qJR1z.vp_runtime";
const STAGING_MIGRATOR_USER = "2K37DPjU76qJR1z.vp_migrator";
const MAX_CERT_BASE64_LENGTH = 64 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const NUMERIC_OPTIONS = new Set([
  "connection_limit", "connect_timeout", "pool_timeout", "socket_timeout",
  "statement_cache_size", "max_connection_lifetime", "max_idle_connection_lifetime"
]);

type StagingTlsSettings = {
  vercelEnv?: string;
  caBase64?: string;
  stagingDbUser?: string;
};

// These errors deliberately omit URL, certificate, filesystem and parser details.
function rejected(reason: string): never {
  throw new Error(`TiDB staging TLS configuration rejected: ${reason}`);
}

function decodeCertificate(encoded: string | undefined): string {
  if (!encoded) rejected("TIDB_CA_CERT_BASE64 is required");
  if (encoded.length > MAX_CERT_BASE64_LENGTH) rejected("invalid CA certificate");
  const base64 = encoded.trim();
  if (!base64 || !BASE64.test(base64)) rejected("invalid CA certificate");

  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) throw new Error();
    const pem = bytes.toString("utf8").trim();
    // Require exactly one PEM certificate; reject private keys, bundles and junk.
    const match = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----$/.exec(pem);
    if (!match) throw new Error();
    const derBase64 = match[1].replace(/[\r\n]/g, "");
    if (!BASE64.test(derBase64)) throw new Error();
    const certificate = new X509Certificate(pem);
    // Also reject trailing DER bytes that OpenSSL might otherwise ignore.
    if (certificate.raw.toString("base64") !== derBase64 || !certificate.ca) throw new Error();
    if (certificate.subject === certificate.issuer && !certificate.verify(certificate.publicKey)) {
      throw new Error();
    }
    const now = Date.now();
    if (!(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))) {
      throw new Error();
    }
    return `${pem}\n`;
  } catch {
    rejected("invalid CA certificate");
  }
}

export function writeCertificateAtomically(pem: string, destination = TIDB_CA_PATH): void {
  // The temporary file is on the same filesystem as the final path. Never write
  // through the final pathname, which might already exist or be a symlink.
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let ownsTemporary = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    ownsTemporary = true;
    writeFileSync(descriptor, pem, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch {
    rejected("unable to install CA certificate");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the safe initialization error. */ }
    }
    if (ownsTemporary) {
      try { unlinkSync(temporary); } catch { /* Already renamed, or cleanup unavailable. */ }
    }
  }
}

export function prepareDatabaseUrl(
  databaseUrl: string,
  settings: StagingTlsSettings,
  installCertificate: (pem: string) => void = writeCertificateAtomically
): string {
  let url: URL | undefined;
  try { url = new URL(databaseUrl); } catch { /* Validate below only for staging. */ }

  const stagingRequested = settings.vercelEnv === "preview"
    || settings.caBase64 !== undefined || settings.stagingDbUser !== undefined
    || url?.pathname === STAGING_DATABASE;
  // Existing production/local connections retain their exact configuration.
  if (!stagingRequested) return databaseUrl;
  if (settings.vercelEnv === "production") rejected("staging configuration is not allowed in production");

  if (!url || databaseUrl !== databaseUrl.trim() || /[\x00-\x20\x7f]/.test(databaseUrl)
    || url.protocol !== "mysql:" || url.hostname !== STAGING_HOST || url.port !== "4000"
    || url.pathname !== STAGING_DATABASE || url.hash || !url.username || !url.password) {
    rejected("DATABASE_URL must target the approved staging database");
  }

  const expectedUser = settings.stagingDbUser;
  if (!expectedUser || expectedUser !== expectedUser.trim() || /[\s\x00-\x1f\x7f]/.test(expectedUser)
    || /(^|\.)root$/i.test(expectedUser)) {
    rejected("TIDB_STAGING_DB_USER must identify the separate staging runtime account");
  }
  if (expectedUser === STAGING_MIGRATOR_USER) {
    rejected("TIDB_STAGING_DB_USER must not use the migrator account");
  }
  if (expectedUser !== STAGING_RUNTIME_USER) {
    rejected("TIDB_STAGING_DB_USER must identify the approved staging runtime account");
  }
  try {
    if (decodeURIComponent(url.username) !== expectedUser) throw new Error();
    // Ensure the password is valid URL encoding, without retaining or logging it.
    if (!decodeURIComponent(url.password)) throw new Error();
  } catch {
    rejected("DATABASE_URL credentials do not match the staging account configuration");
  }

  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) rejected("duplicate DATABASE_URL option");
    seen.add(key);
    if (key === "sslaccept" && value === "strict") continue;
    if (key === "sslcert" && value === TIDB_CA_PATH) continue;
    if (NUMERIC_OPTIONS.has(key) && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) continue;
    // Reject routing overrides (e.g. socket), client identities and insecure TLS.
    rejected("unsupported or unsafe DATABASE_URL option");
  }

  const pem = decodeCertificate(settings.caBase64);
  try { installCertificate(pem); } catch { rejected("unable to install CA certificate"); }
  url.searchParams.set("sslaccept", "strict");
  url.searchParams.set("sslcert", TIDB_CA_PATH);
  return url.toString();
}
