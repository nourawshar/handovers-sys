# Setup Guide — Run the app locally

**Version:** 1.0
**Intended reader:** both developers (`server/` backend and `web/` frontend). Follow this **exactly** so both ends agree on ports, proxy, and wiring. It is consistent with `docs/API_CONTRACT.md` and `docs/SEED_DATA.md`.

The repo is a **monorepo** (per README §11 Phase 0) with this layout at `/opt/data/handovers-sys/`:

```
handovers-sys/
├── README.md          (design doc)
├── docs/              (these contract artifacts)
│   ├── API_CONTRACT.md
│   ├── SEED_DATA.md
│   └── SETUP.md
├── docker-compose.yml (Postgres 15 + optional app container)
├── server/            (Express + Prisma)
└── web/               (React + Vite)
```

> `server/` and `web/` are created by the two developers. **Do not add files to `docs/` from code tasks.** The three `docs/*.md` files are contract-only and must not be edited except by the architect.

---

## 1. Prerequisites

- Node.js 20 LTS+
- npm 10+
- Docker + Docker Compose v2 (for Postgres)
- (Recommended) `pnpm` or npm workspaces if you want a shared root — optional; plain npm is fine.

---

## 2. Environment variables

### 2.1 `server/.env` (backend)

```bash
# --- Database (matches docker-compose.yml below) ---
DATABASE_URL="postgresql://itasset:itasset@localhost:5432/itasset?schema=public"

# --- Auth ---
JWT_ACCESS_SECRET="dev-access-secret-change-me"
JWT_REFRESH_SECRET="dev-refresh-secret-change-me"
ACCESS_TOKEN_TTL="15m"
REFRESH_TOKEN_TTL="7d"

# --- Encryption (AES-256-GCM for Account passwords) ---
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"   # 32-byte hex (64 chars) in dev

# --- App ---
PORT=3001
NODE_ENV=development
CORS_ORIGIN="http://localhost:5173"

# --- Uploads ---
UPLOAD_DIR="./uploads"
MAX_UPLOAD_MB=10

# --- Reporting ---
BACKUP_STALENESS_DAYS=7     # warn if WhatsApp last backup older than this (README §3.6 / A1)
```

### 2.2 `web/.env.local` (frontend)

```bash
VITE_API_BASE="/api"        # relative — Vite proxies to the server (see §6)
```

> Both devs: the frontend MUST call relative `/api/v1/...` (with `VITE_API_BASE=/api`), never a hard-coded `http://localhost:3001`. This guarantees the Vite proxy (dev) and any reverse proxy (prod) both work.

---

## 3. Postgres via Docker Compose

`docker-compose.yml` (repo root):

```yaml
services:
  db:
    image: postgres:15
    container_name: itasset-db
    environment:
      POSTGRES_USER: itasset
      POSTGRES_PASSWORD: itasset
      POSTGRES_DB: itasset
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U itasset"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

Start it (from the repo root):

```bash
docker compose up -d
```

Verify:

```bash
docker compose ps
# db container should be "healthy"
```

---

## 4. Backend: install, migrate, seed, run

All commands in this section run from `server/` (unless noted).

### 4.1 Install

```bash
cd server
npm install
```

### 4.2 First-time database (Prisma)

```bash
npx prisma migrate dev --name init
```

This creates the schema from `server/prisma/schema.prisma` and applies it to the local Postgres. Keep `schema.prisma` in lockstep with the fields in `docs/API_CONTRACT.md` (enums in §2, entities in §5/§7/§8).

### 4.3 Seed the dev database

The seed writes the realistic data from `docs/SEED_DATA.md` (departments, rooms TR1–TR4, work identities incl. `sofia`, the Samsung A12 + SIM `905369700889` assignment, accounts, 3 employees).

Run it:

```bash
npm run seed
```

`server/package.json` must wire the runner (either of these is fine):

```jsonc
// Option A
"prisma": { "seed": "tsx prisma/seed.ts" },
"scripts": {
  "seed": "prisma db seed"
}

// Option B (explicit)
"scripts": {
  "seed": "tsx prisma/seed.ts"
}
```

Verify the canonical record (§9 of SEED_DATA.md):

```bash
npx prisma studio
# check: Assignment A-000001 exists, PhoneAssignmentDetail.wa1ChatNormalCount = 4500,
# Asset PHN-000001 has status ASSIGNED.
```

### 4.4 Run the backend

```bash
npm run dev        # tsx watch src/index.ts (or your dev script)
```

- Server listens on **`http://localhost:3001`**.
- All routes under **`/api/v1`** per `docs/API_CONTRACT.md`.
- Health check: `curl http://localhost:3001/api/v1/auth/me` → `401` (expected, unauthenticated) proves the server and `/api` mount are up.

---

## 5. Frontend: install, run

All commands from `web/`.

### 5.1 Install & run

```bash
cd web
npm install
npm run dev
```

- Vite dev server listens on **`http://localhost:5173`**.
- Open the app: `http://localhost:5173`.
- Log in with a seeded user from §4 of SEED_DATA.md, e.g. `admin` / (dev password from seed).

### 5.2 Vite proxy (the wiring both devs must agree on)

`web/vite.config.ts` must proxy `/api` to the backend so the frontend can use relative URLs:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // "/api/v1/assets" -> "http://localhost:3001/api/v1/assets"
      }
    }
  }
});
```

**Contract for both devs:**
- Backend mounts every route under `/api/v1` (it owns the `/api/v1` prefix).
- Frontend issues requests to `/api/v1/**` (relative) and **never** hard-codes port 3001 in request code.
- Cookies: same-origin through the proxy means the HttpOnly auth cookies (from `API_CONTRACT.md` §1.6) flow correctly in dev. Enable `withCredentials`/`credentials: "include"` on fetch/axios for auth calls if using a separate origin.

---

## 6. End-to-end smoke test (after both are running)

| # | Action | Expected |
|---|--------|----------|
| 1 | Open `http://localhost:5173` | Login screen renders |
| 2 | Login `admin` / seed password | Redirect to `/dashboard`; `GET /api/v1/auth/me` returns ADMIN scope |
| 3 | `npm run seed` was run | `/assets` shows PHN-000001 (Samsung Galaxy A12), status ASSIGNED |
| 4 | `/phones/assign` wizard → assign another phone | POST `/api/v1/assignments/phone` returns 201, asset flips to ASSIGNED |
| 5 | Open `/assignments/A-000001/return` | Two-column out/return form pre-filled from `GET /api/v1/assignments/:id/return-form` |

---

## 7. Common issues

| Symptom | Fix |
|---------|-----|
| `PrismaClientInitializationError` / ECONNREFUSED on 5432 | Postgres container not up — `docker compose up -d` then `docker compose ps` |
| 401 on every `/api` call from the browser | Proxy misconfigured, or cookies not sent — check `vite.config.ts` proxy + `credentials: "include"` |
| Seed fails on duplicate key | Seed must be idempotent (`upsert`/`deleteMany` first) — see SEED_DATA.md §10 |
| `ENCRYPTION_KEY` too short at startup | Must be exactly 32 bytes for AES-256-GCM |
| Port 3001 already used | Change `PORT` in `server/.env` + the proxy `target` in `web/vite.config.ts` together |
