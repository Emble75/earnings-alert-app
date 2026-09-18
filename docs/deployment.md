# Deployment

## Local, with Docker

```bash
cp .env.example .env
# set BOOTSTRAP_USER_PASSWORD so an operator account is created
docker compose up
```

Brings up PostgreSQL, Redis, the migration job, the API, a Celery worker,
Celery beat and the frontend. Demo mode is on by default, so this is a fully
usable system with no credentials and no possibility of a real transaction.

- Console: http://localhost:3000
- API docs: http://localhost:8000/docs

## Local, without Docker

```bash
# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export DATABASE_URL="postgresql+psycopg://arbitrage:arbitrage@localhost:5432/arbitrage"
alembic upgrade head
uvicorn app.main:app --reload

# Worker and scheduler (separate shells)
celery -A app.workers.celery_app.celery_app worker --loglevel=info -Q celery,money
celery -A app.workers.celery_app.celery_app beat --loglevel=info

# Frontend
cd frontend && npm install && npm run dev
```

Seed the demo data:

```bash
python scripts/seed_demo.py --full-order
```

## Checks

```bash
./scripts/check.sh
```

Runs backend lint, the test suite, `alembic check`, frontend typecheck, lint
and build - everything CI would run.

## Production checklist

Before any live money moves:

1. **Secrets.** Generate `SECRET_KEY` with
   `python -c "import secrets; print(secrets.token_urlsafe(48))"`. Never commit
   `.env`. Use your platform's secret manager.
2. **Migrations, not `create_all`.** `ENVIRONMENT=production` disables the
   development convenience that creates tables at startup. Run
   `alembic upgrade head` as a deployment step.
3. **Fee models.** Replace the shipped defaults with the schedule your account
   and category actually incur. Everything downstream depends on them.
4. **Limits.** Set `MAX_CAPITAL_EXPOSURE`, `MAX_CAPITAL_PER_ORDER`,
   `MAX_DAILY_CAPITAL`, `MAX_DAILY_ORDERS` and `MAX_UNITS_PER_PRODUCT` to what
   you can genuinely afford to lose.
5. **Stay in simulation first.** Keep `SIMULATION_MODE=true` until the
   dashboard's expected-vs-realized numbers look right to you.
6. **Webhook secret.** Set `EBAY_WEBHOOK_SECRET`. The live adapter rejects
   unsigned payloads, so without it no webhook is accepted.
7. **Automation level.** Leave it at 2 (one approval per purchase) until you
   trust the numbers. Level 3+ lets a worker spend money unattended.
8. **TLS and CORS.** Terminate TLS in front of the API and set `CORS_ORIGINS`
   to your console's exact origin.
9. **Backups.** `orders`, `order_events`, `capital_reservations` and
   `audit_logs` are your financial record. Back them up and test a restore.
10. **Monitor.** `/api/health` reports provider status and model versions.
    Logs are JSON with `request_id`, `order_id` and `duration_ms`.

## Scaling

- The API is stateless; run several replicas behind a load balancer.
- Run at least two worker processes; keep the `money` queue on its own worker
  so a slow discovery job cannot delay a purchase.
- Exactly one `beat` process. Two schedulers means every job fires twice.
- PostgreSQL is the state of record. Redis holds only the broker and results;
  losing it costs in-flight jobs, not data.

## Failure modes

| Symptom | Cause | What to do |
| --- | --- | --- |
| Everything is demo mode | A provider credential is missing | `/api/health` shows which; the system is refusing to run half-configured |
| Orders stuck in `BLOCKED` | Revalidation found a real problem | The reason is on the order; `POST /orders/{id}/unblock` after fixing it |
| Approval refused as stale | Data aged past `MAX_PRICE_AGE` | Revalidate; the order returns to `APPROVAL_REQUIRED` |
| Purchase failed above ceiling | Source price moved after approval | Working as intended. Revalidate and re-approve at the new price |
| `alembic check` reports drift | Models changed without a migration | `alembic revision --autogenerate` |
