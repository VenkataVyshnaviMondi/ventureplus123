# MySQL application database

`schema.prisma` is the active schema for MySQL 8.0 or newer. UUID IDs remain strings.
Employee assignment lists use JSON columns, uploads use LONGBLOB, and optional
admin/employee codes have unique indexes that allow multiple NULL values.

Set DATABASE_URL in both root `.env` and `server/.env` to:

```dotenv
DATABASE_URL=mysql://venture_user:password@localhost:3306/venture
```

URL-encode special characters in the password. Create the database and grant the
application user access before running these commands from the project root:

```sh
npm run prisma:generate
npm run prisma:deploy -w server
```

For subsequent schema changes in development, use `npm run prisma:migrate -w server`.
Production deployment uses `prisma migrate deploy`; builds do not change the database.
`schemas/estatehub.sql` is an equivalent fresh-database SQL script. Use either the
migration command or SQL import, not both. If you import the SQL directly, mark the
baseline as applied with:

```sh
npx prisma migrate resolve --applied 20261013000000_mysql_baseline --schema database/schema.prisma
```

The previous incomplete MySQL migration history is preserved in `archive/mysql-migrations`.
Do not apply this new baseline over existing tables. Back up existing MySQL databases,
compare their structure with the active schema, and reconcile differences before
marking the baseline applied. Marking a baseline does not change table structure.

Changing providers does not transfer MongoDB records. Existing MongoDB or legacy
Mongoose records need a separate export and import, preserving IDs and inserting
parent records before related records. No existing records were modified by this
conversion.

Optional sample data: `npm run seed -w server`. This deletes application records;
use only with a disposable database. To provision only an administrator, configure
ADMIN_EMAIL and ADMIN_PASSWORD, then run `npm run admin:provision -w server`.

The database/API integration check is `server/tests/mysql-vercel.integration.mjs`.
It requires a separate migrated database whose name ends in `_test`, a running
API pointed at that database, and DATABASE_URL / TEST_BASE_URL in the test environment.
## Transfer existing Prisma MongoDB records

The migration reads the source URL from `backend/.env` (`MONGODB_URI`) and the
destination from `server/.env` (`DATABASE_URL`). Override them with
MONGO_SOURCE_ENV_FILE / MYSQL_TARGET_ENV_FILE (paths relative to the project root),
or MONGO_SOURCE_URL / MYSQL_TARGET_URL. The MongoDB URL must include the database
name containing the application records.

Back up both databases. Prepare a fresh MySQL database with the migration above.
Stop application writes to both databases while transferring. From the root:

```sh
npm run data:migrate:mysql -w server
npm run data:migrate:mysql -w server -- --apply
```

The first command only checks connectivity, source fields and empty destination
tables. The second imports all 14 application models in dependency order, in one
transaction. It verifies every imported field and row count before committing,
and aborts if source records changed during the transfer. It preserves IDs,
password hashes, dates, JSON, and binary uploads. It does not modify MongoDB or
merge into a populated destination. The source snapshot is held in memory; allow
sufficient memory for all records and uploads.

The script supports the Prisma collection names (`User`, `Plot`, etc.). Nonempty
legacy Mongoose collections (`employees`, `admins`, `customers`, etc.) and unknown
fields cause it to stop. They require explicit mappings before transfer to avoid
losing data or changing login behavior.
