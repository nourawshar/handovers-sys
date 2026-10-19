# handovers-server — Backend (Phase 0–1)

Express + PostgreSQL + Prisma API for the IT Asset Management & Device Handover system.
Serves all routes under `/api/v1`. Source of truth for behaviour: `../docs/API_CONTRACT.md`
(data model in `../README.md` §5, RBAC matrix §9).

## Layout

```
server/
├── prisma/
│   ├── schema.prisma     # data model (§5) + enums
│   ├── migrations/       # applied migrations (incl. partial unique index for dual-active)
│   └── seed.js           # idempotent dev seed
├── scripts/
│   ├── dev-db.mjs        # embedded PostgreSQL helper (no Docker needed)
│   └── check-db.js       # sanity-check unique indexes + at-rest encryption
└── src/
    ├── app.js            # express app, middleware order, route mounting
    ├── server.js         # entry point (listen + graceful shutdown)
    ├── config.js         # Zod-validated env config
    ├── db.js             # Prisma client
    ├── middleware/       # auth, rbac, validate, error
    ├── routes/           # auth, users, categories, assets, accounts, photos, lookups
    ├── services/         # auth, asset (EAV + code\~{}sequences), upload, audit
    └── utils/            # tokens, crypto (AES-256-GCM), errors, pagination
```

## Environment variables (`server/.env` — see `.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | e.g. `postgresql://postgres:postgres@localhost:5433/handovers?schema=public` |
| `JWT_ACCESS_SECRET` | yes | ≥ 32 chars |
| `CREDENTIALS_ENC_KEY` | yes | 64 hex chars = 32 bytes for AES-256-GCM (`openssl rand -hex 32`) |
| `PORT` | no | default `4000` |
| `ACCESS_TOKEN_TTL_MIN` | no | default `15` |
| `REFRESH_TOKEN_TTL_DAYS` | no | default `7` |
| `COOKIE_SECURE` | no | `true` in production (HTTPS) |
| `CORS_ORIGIN` | no | comma-separated origins, default `http://localhost:5173` |
| `UPLOAD_DIR` / `MAX_UPLOAD_MB` | no | photo uploads |
| `SEED_ADMIN_PASSWORD` / `SEED_MANAGER_PASSWORD` / `SEED_TL_PASSWORD` | no | seed logins (keep quotes) |
| `SEED_RESET_PASSWORDS` | no | `true` to overwrite seeded-user passwords on re-run |

## Run

> Dev DB: this project includes an **embedded PostgreSQL** helper so you don't need Docker.

```bash
cd server
npm install

# 1) Start the embedded dev Postgres (foreground; Ctrl+C to stop) — port 5433
npm run db:dev
# In a second shell:

# 2) Create/apply schema (first time) — migrations are already committed so this is a no-op
npx prisma migrate dev

# 3) Seed departments, rooms, work identities, phones/accounts/employees
npm run seed

# 4) Start the API on :4000
npm start          # or: npm run dev  (watch mode)
```

Health / smoke:

```bash
curl http://localhost:4000/health          # {"status":"ok"}
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<SEED_ADMIN_PASSWORD>"}'
# then use the Set-Cookie access_token (or returned accessToken) for /api/v1/assets etc.
```

Seeded logins: `admin` / `manager` / `tl.tr1` / `tl.tr2` (passwords from the `SEED_*_PASSWORD`
env vars, defaults: `Admin#12345`, `Manager#12345`, `Leader#12345`).

## Test

Requires a running, seeded server:

```bash
BASE_URL=http://localhost:4000 npm test
```

## DB sanity check

```bash
node scripts/check-db.js
# confirms the unique indexes (asset code, IMEI, active-AssignmentItem) and that
# Account.passwordEnc is stored encrypted (AES-256-GCM), not plaintext.
```
