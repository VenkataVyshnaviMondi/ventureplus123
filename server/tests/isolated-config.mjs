import path from "node:path";
import { isIP } from "node:net";

const fail = () => { throw new Error("Isolated integration configuration rejected"); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const localAbsolute = value => typeof value === "string" && path.isAbsolute(value) && !value.startsWith("\\\\") && !value.startsWith("//");
const host = value => {
  if (typeof value !== "string" || !value || value !== value.trim()) return fail();
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!/^[a-z0-9.:-]+$/.test(normalized) || normalized.includes("..")) return fail();
  if ((/^[0-9.]+$/.test(normalized) && isIP(normalized) !== 4) || /^0x[0-9a-f]+$/.test(normalized)) return fail();
  if (normalized.includes(":")) {
    if (isIP(normalized) !== 6) return fail();
    return new URL(`http://[${normalized}]`).hostname.slice(1, -1);
  }
  return normalized;
};
const account = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(value) &&
  !["root", "mysql.sys", "mysql.session", "mysql.infoschema"].includes(value.toLowerCase());

export function isolatedConfig(environment, policy, execArgv = []) {
  if (environment.VENTURE_TEST_DB_APPROVED !== "yes") fail();
  for (const [key, value] of Object.entries(environment)) {
    if (!value) continue;
    if (/^(DOTENV_|PRISMA_|REDIS_|REALTIME_REDIS_URL$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) fail();
  }
  if (execArgv.some(arg => arg.startsWith("-r") || /^(--require|--import|--env-file|--env-file-if-exists|--loader|--experimental-loader)(=|$)/.test(arg))) fail();
  if (!exactKeys(policy, ["version", "productionHosts", "targets"]) || policy.version !== 1 ||
      !Array.isArray(policy.productionHosts) || !policy.productionHosts.length ||
      !Array.isArray(policy.targets) || !policy.targets.length || policy.targets.length > 16) fail();
  const productionHosts = policy.productionHosts.map(host);
  const targets = policy.targets.map(target => {
    if (!exactKeys(target, ["host", "port", "database", "username", "accountHost", "serverUuid"]) ||
        !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
        typeof target.database !== "string" || !/^[A-Za-z0-9_]+_test$/.test(target.database) ||
        !account(target.username) || typeof target.accountHost !== "string" || !/^[A-Za-z0-9.%:_-]+$/.test(target.accountHost) ||
        typeof target.serverUuid !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target.serverUuid)) fail();
    const normalized = { ...target, host: host(target.host), serverUuid: target.serverUuid.toLowerCase() };
    if (productionHosts.includes(normalized.host)) fail();
    return normalized;
  });
  let url, username;
  try {
    url = new URL(environment.DATABASE_URL);
    username = decodeURIComponent(url.username);
    if (!decodeURIComponent(url.password)) fail();
  } catch { fail(); }
  if (url.protocol !== "mysql:" || url.href.includes("?") || url.href.includes("#") || !account(username)) fail();
  const selected = targets.filter(target => target.host === host(url.hostname) && target.port === Number(url.port || 3306) &&
    url.pathname === `/${target.database}` && target.username === username);
  if (selected.length !== 1 || productionHosts.includes(host(url.hostname)) || environment.VENTURE_TEST_DATABASE !== selected[0].database) fail();
  if (typeof environment.JWT_SECRET !== "string" || environment.JWT_SECRET.length < 32 ||
      !localAbsolute(environment.VENTURE_APP_CHECKOUT)) fail();
  return Object.freeze({ ...selected[0], appCheckout: environment.VENTURE_APP_CHECKOUT,
    databaseUrl: environment.DATABASE_URL, jwtSecret: environment.JWT_SECRET });
}

export function assertDatabaseIdentity(rows, config) {
  if (!Array.isArray(rows) || rows.length !== 1 || !object(rows[0])) fail();
  const row = rows[0];
  if (row.databaseName !== config.database || row.currentUser !== `${config.username}@${config.accountHost}` ||
      typeof row.loginUser !== "string" || !row.loginUser.startsWith(`${config.username}@`) ||
      typeof row.serverUuid !== "string" || row.serverUuid.toLowerCase() !== config.serverUuid) fail();
}

export function assertRestrictedGrants(rows, config) {
  if (!Array.isArray(rows) || !rows.length) fail();
  const required = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  // Require literal escaped database scopes; _ is a MySQL GRANT wildcard.
  const scope = `\`${config.database.replace(/_/g, "\\_")}\`.*`;
  const grantee = `\`${config.username}\`@\`${config.accountHost}\``;
  for (const row of rows) {
    if (!object(row) || Object.keys(row).length !== 1 || typeof Object.values(row)[0] !== "string") fail();
    const statement = Object.values(row)[0];
    if (statement === `GRANT USAGE ON *.* TO ${grantee}`) continue;
    const match = /^GRANT ([A-Z]+(?:, [A-Z]+)*) ON (.+) TO (.+)$/.exec(statement);
    if (!match || match[2] !== scope || match[3] !== grantee) fail();
    const privileges = match[1].split(", ");
    if (new Set(privileges).size !== privileges.length || privileges.some(privilege => !["SELECT", "INSERT", "UPDATE", "DELETE"].includes(privilege))) fail();
    privileges.forEach(privilege => required.delete(privilege));
  }
  if (required.size) fail();
}

// Used by both the real entry point and mocked regression tests. Metadata checks
// need a connection at runtime; the work callback cannot run before they pass.
export async function withIsolatedDatabase(environment, adapters, work) {
  const policyPath = environment.VENTURE_TEST_POLICY_FILE;
  if (!localAbsolute(policyPath)) fail();
  const policy = JSON.parse(await adapters.readPolicy(policyPath));
  const config = isolatedConfig(environment, policy, adapters.execArgv ?? []);
  let restore, prisma;
  try {
    restore = await adapters.enterRuntime(config);
    prisma = await adapters.loadPrisma();
    assertDatabaseIdentity(await prisma.$queryRawUnsafe(
      "SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser, USER() AS loginUser, @@server_uuid AS serverUuid"
    ), config);
    assertRestrictedGrants(await prisma.$queryRawUnsafe("SHOW GRANTS FOR CURRENT_USER()"), config);
    return await work({ prisma, config });
  } finally {
    try { if (prisma) await prisma.$disconnect(); }
    finally { if (restore) await restore(); }
  }
}
