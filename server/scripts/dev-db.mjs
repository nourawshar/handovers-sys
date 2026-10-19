// Dev-only helper: runs a local PostgreSQL (embedded binaries) when Docker/system Postgres isn't available.
// Usage: npm run db:dev   (keeps running in foreground; Ctrl+C to stop)
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.pgdata');
const port = Number(process.env.PG_DEV_PORT || 5433);
const dbName = process.env.PG_DEV_DB || 'handovers';

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error(e),
});

const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(dbName);
console.log(`Dev Postgres ready: postgresql://postgres:postgres@localhost:${port}/${dbName}`);

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
