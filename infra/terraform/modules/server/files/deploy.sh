#!/bin/bash
# Deploys Impex on this server: reads the configuration from SSM Parameter Store, gets the code from GitHub, and runs `docker compose up -d --build`.
# Safe to run again at any time (SSM document "impex-<environment>-deploy" runs it). Log: /var/log/impex-deploy.log
#
#   * /impex/<env>/env/*      -> /opt/impex/.env  (one NAME='value' line per parameter; a value still __SET_ME__ is left out)
#   * /impex/<env>/deploy/*   -> REPO_URL, REPO_BRANCH and (for a private repository) GITHUB_TOKEN
# Database migrations are applied by the one-shot <service>-migrate containers BEFORE each service starts (docs/database-migrations.md); this script never
# touches the data, the volumes or the databases.
set -euo pipefail
exec > >(tee -a /var/log/impex-deploy.log) 2>&1

# shellcheck disable=SC1091
source /opt/impex-deploy/settings
APP=/opt/impex
exec 9>/var/lock/impex-deploy.lock
flock -n 9 || { echo "another deploy is running"; exit 1; }
echo "=== deploy started $(date -u +%FT%TZ) ==="

param() { aws ssm get-parameter --region "$REGION" --name "$SSM_PREFIX/deploy/$1" --with-decryption --query Parameter.Value --output text 2>/dev/null || true; }
REPO_URL="$(param REPO_URL)"
REPO_BRANCH="$(param REPO_BRANCH)"
GITHUB_TOKEN="$(param GITHUB_TOKEN)"
[ -n "$REPO_URL" ] && [ -n "$REPO_BRANCH" ] || { echo "REPO_URL / REPO_BRANCH are not set in SSM under $SSM_PREFIX/deploy"; exit 1; }

# --- the code ---------------------------------------------------------------------------------------------------------------------------------------------------
git_cmd=(git)
if [ -n "$GITHUB_TOKEN" ] && [ "$GITHUB_TOKEN" != "__SET_ME__" ]; then
  auth="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
  git_cmd=(git -c "http.extraheader=AUTHORIZATION: basic $auth")  # the token is never written into the repository's configuration
fi
if [ ! -d "$APP/.git" ]; then
  mkdir -p "$APP"
  "${git_cmd[@]}" clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP"
fi
cd "$APP"
"${git_cmd[@]}" fetch --prune origin "$REPO_BRANCH"
git checkout -q "$REPO_BRANCH"
git reset --hard "origin/$REPO_BRANCH"   # the server never has local edits; the .env file is git-ignored
echo "code: $(git log -1 --format='%h %s')"
# keep this script itself current: the next deploy runs the version that is in the repository
repo_script="$APP/infra/terraform/modules/server/files/deploy.sh"
if [ -f "$repo_script" ] && ! cmp -s "$repo_script" /opt/impex-deploy/deploy.sh; then install -m 700 "$repo_script" /opt/impex-deploy/deploy.sh; echo "deploy script updated for the next run"; fi

# --- the configuration -------------------------------------------------------------------------------------------------------------------------------------------
umask 077
tmp="$(mktemp)"
aws ssm get-parameters-by-path --region "$REGION" --path "$SSM_PREFIX/env" --with-decryption --output json \
  | jq -r '.Parameters[] | select(.Value != "__SET_ME__") | (.Name | split("/") | last) as $k | "\($k)=\(.Value | @sh)"' > "$tmp"   # @sh: single-quoted, any value is safe
for required in POSTGRES_USER POSTGRES_PASSWORD AUTH_INTERNAL_API_KEY ORG_ACTIVATION_API_KEY; do
  grep -q "^$required=" "$tmp" || { echo "required parameter $SSM_PREFIX/env/$required is missing"; rm -f "$tmp"; exit 1; }
done
# The front door: the password in SSM is turned into a bcrypt hash here; only the hash reaches the .env (and the edge container), never the password.
edge_param() { aws ssm get-parameter --region "$REGION" --name "$SSM_PREFIX/edge/$1" --with-decryption --query Parameter.Value --output text; }
EDGE_USER="$(edge_param BASIC_AUTH_USER)"
EDGE_PASSWORD="$(edge_param BASIC_AUTH_PASSWORD)"
[ -n "$EDGE_USER" ] && [ -n "$EDGE_PASSWORD" ] && [ "$EDGE_PASSWORD" != "__SET_ME__" ] || { echo "the front-door user / password are not set under $SSM_PREFIX/edge"; rm -f "$tmp"; exit 1; }
EDGE_PASSWORD_HASH="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$EDGE_PASSWORD")"
printf "EDGE_USER='%s'\nEDGE_PASSWORD_HASH='%s'\n" "$EDGE_USER" "$EDGE_PASSWORD_HASH" >> "$tmp"
unset EDGE_PASSWORD
grep -q "^DOMAIN=" "$tmp" || { echo "required parameter $SSM_PREFIX/env/DOMAIN is missing"; rm -f "$tmp"; exit 1; }

mv "$tmp" "$APP/.env"
chmod 600 "$APP/.env"
echo "configuration: $(wc -l < "$APP/.env") variables from $SSM_PREFIX/env (+ the front door)"

# --- build and start (pending migrations run first, as one-shot containers) ------------------------------------------------------------------------
export COMPOSE_FILE=docker-compose.yml:docker-compose.aws.yml   # the production overlay: nothing is published except the edge (HTTPS + password)
export COMPOSE_BAKE=false
export COMPOSE_PARALLEL_LIMIT=1   # build one image at a time: a small server cannot build two Next.js apps in parallel
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null

echo "--- containers ---"
docker compose ps --format 'table {{.Name}}\t{{.Status}}'
failed="$(docker compose ps --all --format '{{.Name}} {{.Status}}' | grep -E 'migrate' | grep -vF 'Exited (0)' || true)"
if [ -n "$failed" ]; then echo "A MIGRATION DID NOT SUCCEED:"; echo "$failed"; exit 1; fi
echo "=== deploy finished $(date -u +%FT%TZ) ==="
