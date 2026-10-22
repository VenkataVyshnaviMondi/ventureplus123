# Isolated integration runner

This runner is opt-in. It creates one synthetic ADMIN account and customer records,
exercises browser-cookie and actual native-client API round trips, and removes only
the synthetic IDs it created. It does not migrate schemas, test an Android device,
exercise every role/entity, or validate a deployed Vercel Preview.

## Required owner setup — not performed by this change

1. Provide a dedicated MySQL test instance and empty `_test` schema, with no copied
   production data. Initialize it from the website's reviewed MySQL migration using
   separately authorized provisioning credentials. The runner never provisions it.
2. Provide a dedicated runtime account with only SELECT, INSERT, UPDATE and DELETE
   on that exact schema. No roles, global privileges except USAGE, grant/admin
   options, schema creation, triggers, routines, proxy privileges or production
   access. Keep provisioning credentials out of the test process. Independently
   verify schema objects have no triggers or external effects; grants alone cannot
   prove a server/schema is harmless.
3. Obtain the actual authenticated principal (`CURRENT_USER()`), server UUID and
   grant output through the database owner's protected procedure. No credentials
   or connection URLs belong in chat, source, the policy file or reports.
4. Protect a local owner-reviewed JSON policy file outside the checkouts with OS
   permissions preventing untrusted edits. Protect its parent directories too;
   do not use network mounts, symlinks or junctions for configuration/checkouts.
   The file is an explicit trust input, not proof of owner authorization by itself.

Policy shape (fictional examples; replace all identities with independently verified
values; no example target is built into the runner):

```json
{
  "version": 1,
  "productionHosts": ["production-db.example.test", "192.0.2.1"],
  "targets": [{
    "host": "127.0.0.1",
    "port": 3307,
    "database": "venture_test",
    "username": "venture_runner",
    "accountHost": "localhost",
    "serverUuid": "00000000-0000-4000-8000-000000000001"
  }]
}
```

`accountHost` is the authenticated MySQL account's host component, not necessarily
the connection hostname. Declare all production hostnames/IP aliases as denied;
an allowed target cannot overlap any declared production host. Exact tuple matching
is required; a `_test` suffix and approval flag alone are insufficient.

5. Enforce default-deny OS/container/firewall egress: allow only the verified test
   database IP/port plus loopback HTTP for the runner's ephemeral API. Deny production
   DB addresses and Redis/broker access, including alternate addresses/ports and IPv6.
   Prevent DNS/proxy/tunnel redirection. Prefer a dedicated local test instance.
   For remote infrastructure, independently establish authenticated TLS and approved
   network isolation first. URL query/connection overrides are intentionally rejected;
   deployments needing such TLS options require a separate reviewed change.
6. Start a clean trusted Node process, using trusted dependencies and a MySQL-generated
   Prisma client. Node preloads can execute before this runner, so the guard cannot
   undo an already executed preload. Inherited Redis, DOTENV/PRISMA overrides,
   NODE_OPTIONS/NODE_PATH and preload/env-file arguments are rejected. The runner
   sanitizes app configuration and changes into an empty temporary directory before
   importing app/Prisma modules; project dotenv files are not a configuration source.

Supply these process environment variables through protected local tooling:

- `VENTURE_TEST_POLICY_FILE`: absolute path to the protected local JSON policy.
- `DATABASE_URL`: dedicated test account connection matching one policy tuple exactly.
- `VENTURE_TEST_DATABASE`: exact approved schema name.
- `JWT_SECRET`: unique high-entropy test-only secret (at least 32 characters; generate
  securely, never reuse production). Length checks cannot prove entropy or uniqueness.
- `VENTURE_APP_CHECKOUT`: absolute path to the existing trusted app repair checkout.
- `VENTURE_TEST_DB_APPROVED=yes`: explicit operator acknowledgment, not isolation proof.

Do not inherit production Redis configuration. No secrets are generated or displayed
by setup documentation. Do not put them in shell command arguments or Git.

## Checks and execution gates

Mock-only checks from the website repository root:

```text
node --test server/tests/isolated-config.test.mjs
node --check server/tests/isolated-config.mjs
node --check server/tests/isolated-runtime.mjs
node --check server/tests/shared-data.integration.mjs
```

The tests trap networking APIs and use fake Prisma/app-work adapters. They verify
zero real network calls and zero fake writes on rejection, plus a fake positive
control. They do not establish actual DB permissions, DNS/TLS identity, firewall
enforcement, server/schema integrity, policy-file trust or production isolation.

Before the first real run, independently verify all owner controls above and build
the current backend with the already generated MySQL client. The shared-data script
deliberately does not run a build/Prisma generation before preflight. No migration,
seed, package installation or database-backed test is part of the mock checks.

Only after owner approval/configuration is available, run `npm run test:shared-data
--workspace server` from the website root. Metadata reads necessarily connect to the
approved test endpoint at runtime. DATABASE(), CURRENT_USER(), USER(), server UUID
and strict grants must pass before app startup or synthetic writes. Runtime identity
failure prevents writes; only enforced network isolation can prevent contacting an
unintended server in the first place. Unexpected syntax/metadata fails closed.

Database grant scopes must escape literal underscores (`venture\_test`). Unescaped
underscores and percent patterns are rejected because MySQL treats them as grant
wildcards in common configurations. Unknown SHOW GRANTS representations, partial
revokes semantics or unsupported server metadata require owner investigation; do
not relax the guard to make a test pass. See the
[MySQL GRANT reference](https://dev.mysql.com/doc/refman/8.4/en/grant.html).

Keep real DB/Vercel/Android acceptance results separate from these mock results.
Legacy ownership mapping remains a separate security-release blocker.
