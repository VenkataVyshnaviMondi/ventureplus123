import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const readPolicy = filename => {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("A regular local policy file is required");
  return fs.readFileSync(filename, "utf8");
};

export function enterRuntime(config, runtime = process) {
  const previous = { ...runtime.env };
  const previousCwd = runtime.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "venture-isolated-"));
  const operatingSystemKeys = new Set(["PATH", "Path", "SystemRoot", "WINDIR", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "ComSpec", "PATHEXT"]);
  const restore = () => {
    runtime.chdir(previousCwd);
    for (const key of Object.keys(runtime.env)) delete runtime.env[key];
    Object.assign(runtime.env, previous);
    // Never recursively delete; only remove the empty directory created above.
    fs.rmdirSync(directory);
  };
  try {
    for (const key of Object.keys(runtime.env)) if (!operatingSystemKeys.has(key)) delete runtime.env[key];
    Object.assign(runtime.env, { DATABASE_URL: config.databaseUrl, JWT_SECRET: config.jwtSecret,
      NODE_ENV: "production", LOG_LEVEL: "silent", REALTIME_REDIS_URL: "", REALTIME_TRANSPORT: "sse",
      COOKIE_DOMAIN: "", COOKIE_SAMESITE: "lax", CSRF_COOKIE_NAME: "estatehub_csrf",
      ACCESS_TOKEN_COOKIE_NAME: "estatehub_access", JWT_EXPIRES_IN: "5m", CORS_ORIGIN: "http://127.0.0.1" });
    // env.ts's dotenv.config() sees a private empty cwd, never the project .env.
    runtime.chdir(directory);
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}
