#!/usr/bin/env python3
"""Verifies the database-migration workflow (docs/database-migrations.md) against the Docker Compose configuration and, with --live, the running PostgreSQL.

    python scripts/verify_migration_gate.py          # static: reads `docker compose config`, changes nothing
    python scripts/verify_migration_gate.py --live   # also drives throwaway SCRATCH databases through pending -> migrated, and a failing migration step

Static checks (no containers are started):
  * every database-backed service (auth, organization, inventory, purchasing, sales, support, finance) has a one-shot `<name>-migrate` container that runs the SAME image,
    against the SAME database, with `restart: no`, no volume, and the command `python -m app.db_migrations`;
  * the service depends on it with `condition: service_completed_successfully` (so a failed migration keeps the service from starting) and on a healthy PostgreSQL;
  * nothing in the Compose file, the Dockerfiles, the services' application code or the scripts stamps a database, resets one or deletes a volume.

Live checks (--live) use scratch databases named impex_gate_<name>, created and dropped here: the real databases and every Docker volume are never touched.
  * on a database with pending migrations the service's gate refuses (non-zero exit, "NOT READY");
  * the migration container applies them ("DATABASE MIGRATION SUCCEEDED"), a second run reports "nothing to apply", and the gate then passes;
  * with the migration step forced to fail (a temporary Compose override), `docker compose run <service>` does NOT start the service.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICES = ["auth", "organization", "inventory", "purchasing", "sales", "support", "finance"]
failures = []


def check(condition, message):
    print(("  ok    " if condition else "  FAIL  ") + message)
    if not condition:
        failures.append(message)


def run(*args, check_rc=False, extra_env=None):
    result = subprocess.run(list(args), cwd=ROOT, capture_output=True, text=True, errors="replace")
    if check_rc and result.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(args)}\n{result.stdout}\n{result.stderr}")
    return result


def compose_config():
    out = run("docker", "compose", "config", "--format", "json", check_rc=True).stdout
    return json.loads(out)["services"]


def static_checks():
    print("Compose configuration")
    services = compose_config()
    for name in SERVICES:
        app, migrate = services.get(f"{name}-service"), services.get(f"{name}-migrate")
        check(migrate is not None, f"{name}: a one-shot {name}-migrate container exists")
        if migrate is None or app is None:
            continue
        check(migrate.get("image") == app.get("image"), f"{name}: the migration container runs the same image as the service ({app.get('image')})")
        check(migrate.get("restart") == "no", f"{name}: the migration container never restarts on its own")
        check(migrate.get("command") == ["python", "-m", "app.db_migrations"], f"{name}: the migration container only runs `python -m app.db_migrations`")
        check(migrate["environment"].get("DB_NAME") == app["environment"].get("DB_NAME"), f"{name}: it migrates the same database as the service ({app['environment'].get('DB_NAME')})")
        check(not migrate.get("volumes"), f"{name}: the migration container mounts no volume")
        check(migrate["depends_on"].get("postgres", {}).get("condition") == "service_healthy", f"{name}: it waits for a healthy PostgreSQL")
        gate = app["depends_on"].get(f"{name}-migrate", {})
        check(gate.get("condition") == "service_completed_successfully", f"{name}: the service waits for its migrations to complete successfully")
        check(app["depends_on"].get("postgres", {}).get("condition") == "service_healthy", f"{name}: the service still waits for a healthy PostgreSQL")
        check("healthcheck" in app, f"{name}: the service reports healthy only once it is up (health check)")
    print("Nothing destructive in the deployment files")
    files = [ROOT / "docker-compose.yml", *ROOT.glob("services/*/Dockerfile"), *ROOT.glob("services/*/app/**/*.py"), *ROOT.glob("scripts/*.py")]
    patterns = [r"alembic\s+stamp", r"command\.stamp", r"down\s+(-\w+\s+)*-v\b", r"--volumes", r"DROP\s+DATABASE", r"drop_all\(", r"volume\s+rm", r"system\s+prune"]
    hits = []
    for path in files:
        if path.name in ("verify_migration_gate.py", "_cleanup.py") or "tests" in path.parts:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        text = re.sub(r'""".*?"""', "", text, flags=re.S) if path.suffix == ".py" else text
        text = re.sub(r"(^|\s)#.*$", "", text, flags=re.M)  # comments may name what is never done (YAML, Dockerfile, Python)
        hits += [f"{path.relative_to(ROOT)}: {p}" for p in patterns if re.search(p, text, re.I)]
    check(not hits, "no `alembic stamp`, database reset or volume deletion anywhere in deployment code" + (f" (found: {hits})" if hits else ""))


def psql(sql):
    return run("docker", "compose", "exec", "-T", "postgres", "sh", "-c", f'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "{sql}"')


def live_checks():
    print("Live: scratch databases (the real databases are not touched)")
    for name in SERVICES:
        db = f"impex_gate_{name}"
        psql(f'DROP DATABASE IF EXISTS {db} WITH (FORCE)')
        check(psql(f"CREATE DATABASE {db}").returncode == 0, f"{name}: scratch database created")
        try:
            gate = ["docker", "compose", "run", "--rm", "--no-deps", "-e", f"DB_NAME={db}", "-e", "SCHEMA_CHECK_WAIT_SECONDS=5", f"{name}-service",
                    "python", "-c", "from app.db_migrations import verify_database_schema as v; v()"]
            pending = run(*gate)
            check(pending.returncode != 0 and "NOT READY" in pending.stderr + pending.stdout, f"{name}: with migrations pending the service's gate refuses to open")
            step = ["docker", "compose", "run", "--rm", "--no-deps", "-e", f"DB_NAME={db}", f"{name}-migrate"]
            first = run(*step)
            check(first.returncode == 0 and "DATABASE MIGRATION SUCCEEDED" in first.stdout, f"{name}: the migration container applies them and says so")
            second = run(*step)
            check(second.returncode == 0 and "nothing to apply" in second.stdout, f"{name}: running it again applies nothing")
            opened = run(*gate)
            check(opened.returncode == 0 and "database schema OK" in opened.stdout, f"{name}: the gate opens once the database is at head")
        finally:
            psql(f"DROP DATABASE IF EXISTS {db} WITH (FORCE)")

    print("Live: a failing migration step keeps the service from starting")
    override = Path(tempfile.mkdtemp(prefix="impex-gate-")) / "override.yml"
    override.write_text('services:\n  support-migrate:\n    command: ["sh", "-c", "echo \'[migrate:support] DATABASE MIGRATION FAILED (simulated)\'; exit 1"]\n', encoding="utf-8")
    try:
        started = run("docker", "compose", "-f", "docker-compose.yml", "-f", str(override), "run", "--rm", "support-service", "python", "-c", "print('SERVICE-STARTED')")
        output = started.stdout + started.stderr
        check(started.returncode != 0 and "SERVICE-STARTED" not in output, "support: with its migration step failing, `docker compose run support-service` does not start the service")
    finally:
        override.unlink(missing_ok=True)
        run("docker", "compose", "rm", "-f", "support-migrate")  # drop the failed one-shot container; the next `up` recreates it from the real configuration


def main():
    static_checks()
    if "--live" in sys.argv:
        live_checks()
    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED")
        sys.exit(1)
    print("All migration-workflow checks passed.")


if __name__ == "__main__":
    main()
