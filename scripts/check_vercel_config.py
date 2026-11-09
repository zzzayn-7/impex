#!/usr/bin/env python3
"""Checks vercel.json against the code, so the service bindings can never drift from who really calls whom.

    python scripts/check_vercel_config.py

For every service in vercel.json it reads the source and finds the *_SERVICE_URL variables the code uses to reach another service
(os.getenv in Python, process.env in the Next.js apps), and verifies that:
  * each of them has a binding with exactly that `env` name, aimed at the right service;
  * every binding is used by the code (no stale or invented call);
  * every binding is well-formed (type "service", format "url", an existing target, never the service itself);
  * the public rewrites only target existing services, and no backend service is public;
  * every schedule calls a route that exists in the service that serves the default host, and handles the schedule's HTTP method.
Exit code 0 = consistent.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
services = config["services"]

# the variable each target service is reached through (the names the code and docker-compose already use)
ENV_FOR_TARGET = {
    "auth-service": "AUTH_SERVICE_URL", "organization-service": "ORG_SERVICE_URL", "inventory-service": "INVENTORY_SERVICE_URL", "sales-service": "SALES_SERVICE_URL",
    "purchasing-service": "PURCHASING_SERVICE_URL", "support-service": "SUPPORT_SERVICE_URL", "finance-service": "FINANCE_SERVICE_URL",
}
TARGET_FOR_ENV = {v: k for k, v in ENV_FOR_TARGET.items()}
PATTERN = re.compile(r"""["']((?:AUTH|ORG|INVENTORY|SALES|PURCHASING|SUPPORT|FINANCE)_SERVICE_URL)["']|process\.env\.((?:AUTH|ORG|INVENTORY|SALES|PURCHASING|SUPPORT|FINANCE)_SERVICE_URL)""")
SKIP_DIRS = {"node_modules", ".next", "tests", "__pycache__", "alembic", ".venv"}
problems = []


def used_by(root: Path) -> set:
    found = set()
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in (".py", ".ts", ".tsx", ".mjs") or SKIP_DIRS & set(path.relative_to(root).parts):
            continue
        for match in PATTERN.finditer(path.read_text(encoding="utf-8", errors="ignore")):
            found.add(match.group(1) or match.group(2))
    return found


for name, spec in services.items():
    code_uses = used_by(ROOT / spec["root"])
    bindings = spec.get("bindings", [])
    seen_env = set()
    for b in bindings:
        if b.get("type") != "service" or b.get("format") != "url" or not {"service", "env"} <= set(b):
            problems.append(f"{name}: malformed binding {b}")
            continue
        if b["service"] not in services:
            problems.append(f"{name}: binding targets unknown service {b['service']!r}")
        if b["service"] == name:
            problems.append(f"{name}: binds to itself")
        if b["env"] in seen_env:
            problems.append(f"{name}: env {b['env']} bound twice")
        seen_env.add(b["env"])
        if TARGET_FOR_ENV.get(b["env"]) != b["service"]:
            problems.append(f"{name}: env {b['env']} is aimed at {b['service']!r}, but the code reads it as {TARGET_FOR_ENV.get(b['env'])!r}")
    missing = code_uses - seen_env
    unused = seen_env - code_uses
    if missing:
        problems.append(f"{name}: the code reads {sorted(missing)} but there is no binding for it")
    if unused:
        problems.append(f"{name}: bindings {sorted(unused)} are never read by the code")
    print(f"{name:22} reads {', '.join(sorted(code_uses)) or '-'}")

public = {r["destination"]["service"] for r in config.get("rewrites", []) if isinstance(r.get("destination"), dict)}
for target in public:
    if target not in services:
        problems.append(f"a rewrite targets unknown service {target!r}")
    if services.get(target, {}).get("framework") == "fastapi":
        problems.append(f"backend service {target!r} is public (it should stay internal)")
# a service that installs with `npm ci` needs its lockfile (otherwise the deployment would fail, or float to whatever is newest)
for name, spec in services.items():
    if "npm@" in spec.get("installCommand", "") and " ci" in spec["installCommand"] and not (ROOT / spec["root"] / "package-lock.json").is_file():
        problems.append(f"{name}: installs with `npm ci` but {spec['root']}/package-lock.json is missing")
print("public services:", ", ".join(sorted(public)))
# every schedule must call a route that exists in the service the default host serves, and that route's service must be bound by that service
default_service = config["rewrites"][-1]["destination"]["service"]
for name, schedule in config.get("schedules", {}).items():
    route = ROOT / services[default_service]["root"] / "src" / "app" / schedule["path"].strip("/") / "route.ts"
    if not route.is_file():
        problems.append(f"schedule {name!r} calls {schedule['path']}, but {route.relative_to(ROOT)} does not exist")
    method = schedule.get("requestMethod", "POST")
    if route.is_file() and f"export async function {method}" not in route.read_text(encoding="utf-8", errors="ignore"):
        problems.append(f"schedule {name!r}: the route does not handle the schedule's method ({method})")
    print(f"schedule {name:16} {schedule['schedule']:14} -> {default_service} {schedule['path']}")
if config.get("rewrites", [])[-1:] and config["rewrites"][-1].get("has"):
    problems.append("the catch-all rewrite must come last and have no host condition")

if problems:
    print("\nPROBLEMS:")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print("\nvercel.json matches the code.")
