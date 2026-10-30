# TiDB staging TLS

The server validates and installs the CA synchronously before constructing
PrismaClient. No database connection or migration is part of this bootstrap.
Prisma 5.22.0 uses `sslcert` as the CA file and `sslaccept=strict` for certificate
and hostname verification. `NODE_EXTRA_CA_CERTS` is not a substitute for this
Prisma engine configuration.

## Server-only Preview configuration

Configure these only after separate authorization, scoped to Vercel **Preview**
(and `fix/shared-native-auth` if other preview branches should remain separate):

| Variable | Required value |
| --- | --- |
| `DATABASE_URL` | URL below, using the separate staging runtime account |
| `TIDB_STAGING_DB_USER` | Exactly `2K37DPjU76qJR1z.vp_runtime` (case-sensitive, unencoded) |
| `TIDB_CA_CERT_BASE64` | Standard base64 of the trusted CA PEM file; one certificate, no private key |
| `JWT_SECRET` | Independently generated preview-only authentication secret; existing requirement |

```text
mysql://<URL_ENCODED_STAGING_RUNTIME_USER>:<URL_ENCODED_STAGING_PASSWORD>@gateway01.ap-northeast-1.prod.aws.tidbcloud.com:4000/ventureplus_staging?sslaccept=strict&sslcert=%2Ftmp%2Ftidb-ca.pem
```

Encode the username/password components, not the entire URL. `VERCEL_ENV=preview`
must be available at runtime from Vercel system environment variables. Preview
always requires the CA and explicit staging username, including when `NODE_ENV`
is `production`. The CA file is created at **runtime** in `/tmp/tidb-ca.pem`; a
build-time file or a Windows laptop path does not work in a Vercel function.

The bootstrap checks the exact host, port, database and pinned runtime username.
Both the configured username and the decoded URL username must equal
`2K37DPjU76qJR1z.vp_runtime`. The migrator account
`2K37DPjU76qJR1z.vp_migrator`, root accounts and all other usernames are rejected. It
adds strict TLS options when absent and rejects conflicting/duplicate options,
socket overrides and other unapproved parameters. Numeric Prisma pool/timeout
options are allowed. The PEM must decode canonically, contain exactly one valid,
currently valid X.509 CA certificate and contain no additional data. Self-issued
CA signatures are also verified. Installation
uses an exclusive temporary file with mode `0600`, a flushed write and same-folder
atomic rename. Validation/write errors abort initialization without logging input
values, underlying exceptions or certificate contents. An old CA file is never a
fallback for missing/invalid configuration.

Ordinary local and production URLs are returned unchanged when there is no
staging configuration. Supplying either TiDB variable, or using the staging
database name, also enables validation outside Vercel. Staging configuration is
rejected when `VERCEL_ENV=production`; it must not be configured in Production.
Do not disable the Vercel system environment variables that identify Preview.

## Isolation and secret handling

TiDB's gateway is shared, and `prod` in its DNS name is the provider's naming,
not this application's database environment. The full username identifies the
intended cluster/account and must be independently checked by the owner. Use a
separate, least-privileged runtime account restricted to `ventureplus_staging`,
with a new password. The application cannot prove that a password was never used
in production, or inspect database grants without connecting. It does not read or
compare production credentials. Do not use a root or migration account.

Verify the CA provenance against TiDB's connection instructions. Encode the local
CA in a trusted local process and supply it directly to the server environment;
do not print it, put it in a command argument/history, or save an encoded copy in
the repository. Base64 is encoding, not encryption. Neither the CA content nor
credentials belong in Flutter assets, APK defines, VITE_* variables, logs or Git.
No client code reads these variables. The CA file does not need bundling into the
deployment. Keep staging JWT credentials independent of production as well.

The bootstrap only covers the application's PrismaClient. Prisma CLI migrations,
seed scripts and other standalone clients do not run it. Do not use them as a TLS
test or run migrations automatically. A future explicitly authorized preview
test must verify the actual TiDB handshake, runtime filesystem, network policy,
account permissions, and authentication with fictional data. Unit tests cannot
establish live connectivity or confirm database isolation.

## Offline checks

`npm run test:tls -w server` builds the server and runs certificate, destination,
atomic installation, initialization order and production compatibility tests.
Tests use public CA certificates already bundled with Node and temporary files;
no TiDB certificate, database password or private key is committed. Prisma is
stubbed for initialization tests; these tests do not connect to a database.

References: [Prisma 5.22.0 MySQL TLS implementation](https://github.com/prisma/prisma-engines/blob/5.22.0/quaint/src/connector/mysql/url.rs),
[Vercel system variables](https://vercel.com/docs/environment-variables/system-environment-variables).
