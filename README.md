# Impex Microservices Platform

A modular multi-tenant enterprise system for import-export trade management, logistics, and multi-organization operations.

---

## 🏗️ Architecture & Project Structure

```text
impex/
│
├── frontend/
│   ├── super-admin/               # Next.js 14 Management Console
│   └── dashboard/                 # Next.js Client / Tenant Portal (Planned)
│
├── services/
│   ├── auth-service/              # FastAPI Authentication & User Identity
│   │   ├── app/
│   │   │   └── main.py
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   │
│   ├── organization-service/      # FastAPI Tenant & Organization Management
│   │   ├── app/
│   │   │   └── main.py
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   │
│   ├── inventory-service/         # Warehousing & Stock Tracking (Planned)
│   ├── sales-service/             # Clients, Delivery Lists, Dispatches, Invoices & Payments
│   ├── support-service/           # Help & Support tickets, Support Inbox, durable e-mail notifications
│   └── finance-service/           # Chart of accounts, double-entry journal, expenses, postings from Sales & Purchasing
│
├── gateway/
│   └── nginx.conf                 # NGINX Reverse Proxy & API Gateway
│
├── docker-compose.yml             # Container Orchestration
├── .env.example                   # Environment Variables Template
├── .gitignore                     # Git Ignore Definitions
└── README.md
```

---

## 🚀 Quick Start (Docker Compose)

### 1. Copy Environment Variables
```bash
cp .env.example .env
```

### 2. Build and Start All Services
```bash
docker compose up --build
```
Database migrations are applied automatically, **before** each service starts (a one-shot `<name>-migrate` container per service); a failed migration keeps the service from
starting and the data in the `postgres_data` volume is never reset. See [`docs/database-migrations.md`](docs/database-migrations.md).

### 3. Access Services
- **Super Admin Frontend**: [http://localhost](http://localhost) (or directly at [http://localhost:3000](http://localhost:3000))
- **Auth Service Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)
- **Organization Service Docs**: [http://localhost:8001/docs](http://localhost:8001/docs)
- **Support Service Docs**: [http://localhost:8005/docs](http://localhost:8005/docs) (Help & Support: see [`docs/support.md`](docs/support.md))
- **Organization Settings** (company profile, branding, your own name, business preferences): see [`docs/settings.md`](docs/settings.md)
- **Module management** (which business modules each organization can use): see [`docs/modules.md`](docs/modules.md)

---

## 🌐 API Gateway Routing (NGINX)

All external traffic enters through port `80` managed by the NGINX API gateway:

| Route Path | Upstream Target | Description |
| :--- | :--- | :--- |
| `/` | `super-admin:3000` | Super Admin Next.js Frontend |
| `/_next/webpack-hmr` | `super-admin:3000` | Next.js HMR WebSocket stream |
| `/api/v1/auth/` | `auth-service:8000` | Authentication, Token, and Profile endpoints |
| `/api/v1/organizations/` | `organization-service:8001` | Tenant and Organization CRUD endpoints |

---

## 🛠️ Local Development (Without Docker)

### Auth Service (FastAPI)
```bash
cd services/auth-service
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
# source .venv/bin/activate
pip install -r requirements.txt
python -m app.db_migrations   # apply pending database migrations first (the service refuses to start on a database that is not at its migration head)
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Organization Service (FastAPI)
```bash
cd services/organization-service
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
# source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

### Super Admin (Next.js)
```bash
cd frontend/super-admin
npm install
npm run dev
```

---

## 🔐 Multi-tenancy

Organizations are isolated from each other. An organization administrator can only ever reach their own
organization: the tenant is taken from the authenticated user, never from the request. Every future service that
stores organization data must follow the rules and use the helpers described in
[`docs/multi-tenancy.md`](docs/multi-tenancy.md).

---

## 🗺️ Roadmap & Planned Services

- **`frontend/dashboard`**: Tenant-facing analytics, inventory tracking, and order placement.
- **`services/inventory-service`**: Stock tracking (one stock figure per product), SKU management and barcodes.
- **`services/sales-service`**: Clients, delivery lists, dispatches, sales invoices and client payments are built (see [`services/sales-service/README.md`](services/sales-service/README.md)). Quotes, orders, returns and refunds are planned.
- **`services/finance-service`**: the foundation is built — chart of accounts, double-entry journal, expenses and automatic postings from Sales and Purchasing (see [`docs/finance.md`](docs/finance.md)). Financial statements and analytics (Step 21B), bank integration, exchange rates and tax compliance are planned.

---

## ✅ Automated tests

Every push to `main` and every pull request runs the backend suites and the portal tests in GitHub Actions against a throwaway database. See [`docs/continuous-integration.md`](docs/continuous-integration.md).
