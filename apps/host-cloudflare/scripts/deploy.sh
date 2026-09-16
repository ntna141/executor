#!/usr/bin/env bash
# One-shot deploy for the Executor Cloudflare host.
#
# Provisions everything a fresh account needs and deploys the Worker:
#   1. verifies wrangler is logged in
#   2. creates (or reuses) the `executor` D1 database and writes its id into
#      wrangler.jsonc
#   3. creates (or reuses) the `executor-blobs` R2 bucket
#   4. generates + uploads EXECUTOR_SECRET_KEY (the at-rest secret key) if unset
#   5. uploads the shared WorkAgent JWT secret when supplied
#   6. uploads the Executor-to-Spark tool JWT secret when supplied
#   7. deploys the Worker
#
# Idempotent — safe to re-run. Run from anywhere:
#   bash apps/host-cloudflare/scripts/deploy.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$APP_DIR/wrangler.jsonc"
cd "$APP_DIR"

BUNX=(npx --yes bun@1.3.11 x)

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }

step "Checking wrangler login"
if ! "${BUNX[@]}" wrangler whoami >/dev/null 2>&1; then
  info "Not logged in. Run: npx bun x wrangler login"
  exit 1
fi
info "Logged in."

step "Provisioning D1 database 'executor'"
# `d1 create` is non-idempotent (errors if it exists), so list first.
EXISTING_ID="$("${BUNX[@]}" wrangler d1 list --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).find(d=>d.name==="executor");process.stdout.write(r?r.uuid:"")}catch{}})')"
if [ -n "$EXISTING_ID" ]; then
  DB_ID="$EXISTING_ID"
  info "Reusing existing database: $DB_ID"
else
  CREATE_OUT="$("${BUNX[@]}" wrangler d1 create executor 2>&1)"
  DB_ID="$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  info "Created database: $DB_ID"
fi
[ -n "$DB_ID" ] || { echo "Failed to resolve D1 database id" >&2; exit 1; }

step "Writing D1 id into wrangler.jsonc"
# Replace whatever database_id is present (placeholder or a prior id).
node -e '
  const fs=require("fs"),p=process.argv[1],id=process.argv[2];
  let t=fs.readFileSync(p,"utf8");
  t=t.replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`);
  fs.writeFileSync(p,t);
' "$CONFIG" "$DB_ID"
info "wrangler.jsonc -> $DB_ID"

step "Provisioning R2 bucket 'executor-blobs'"
if "${BUNX[@]}" wrangler r2 bucket list 2>/dev/null | grep -q 'executor-blobs'; then
  info "Reusing existing bucket."
else
  "${BUNX[@]}" wrangler r2 bucket create executor-blobs >/dev/null
  info "Created bucket."
fi

step "Ensuring EXECUTOR_SECRET_KEY secret"
if "${BUNX[@]}" wrangler secret list 2>/dev/null | grep -q EXECUTOR_SECRET_KEY; then
  info "Secret already set — leaving it."
else
  SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  printf '%s' "$SECRET" | "${BUNX[@]}" wrangler secret put EXECUTOR_SECRET_KEY >/dev/null
  info "Generated + uploaded a fresh 32-byte key."
fi

step "Ensuring SPARK_TO_EXECUTOR_JWT_SECRET secret"
if [ -n "${SPARK_TO_EXECUTOR_JWT_SECRET:-}" ] && [ "${#SPARK_TO_EXECUTOR_JWT_SECRET}" -ge 32 ]; then
  printf '%s' "$SPARK_TO_EXECUTOR_JWT_SECRET" \
    | "${BUNX[@]}" wrangler secret put SPARK_TO_EXECUTOR_JWT_SECRET >/dev/null
  printf '%s' "$SPARK_TO_EXECUTOR_JWT_SECRET" \
    | "${BUNX[@]}" wrangler secret put SPARK_TO_EXECUTOR_JWT_SECRET --name cloudflare-chat-agent >/dev/null
  info "Uploaded the same WorkAgent JWT secret to Executor and Spark."
elif "${BUNX[@]}" wrangler secret list 2>/dev/null | grep -q SPARK_TO_EXECUTOR_JWT_SECRET; then
  info "Executor secret already exists. Confirm Spark has the matching SPARK_TO_EXECUTOR_JWT_SECRET."
else
  info "Set SPARK_TO_EXECUTOR_JWT_SECRET to the same 32+ character value used by WorkAgent, then rerun."
  exit 1
fi

step "Ensuring EXECUTOR_TO_SPARK_JWT_SECRET secret"
if [ -n "${EXECUTOR_TO_SPARK_JWT_SECRET:-}" ] && [ "${#EXECUTOR_TO_SPARK_JWT_SECRET}" -ge 32 ]; then
  printf '%s' "$EXECUTOR_TO_SPARK_JWT_SECRET" \
    | "${BUNX[@]}" wrangler secret put EXECUTOR_TO_SPARK_JWT_SECRET >/dev/null
  printf '%s' "$EXECUTOR_TO_SPARK_JWT_SECRET" \
    | "${BUNX[@]}" wrangler secret put EXECUTOR_TO_SPARK_JWT_SECRET --name cloudflare-chat-agent >/dev/null
  info "Uploaded the same tool-call secret to Executor and Spark."
elif "${BUNX[@]}" wrangler secret list 2>/dev/null | grep -q EXECUTOR_TO_SPARK_JWT_SECRET; then
  info "Executor secret already exists. Confirm Spark has the matching EXECUTOR_TO_SPARK_JWT_SECRET."
else
  info "Set EXECUTOR_TO_SPARK_JWT_SECRET to a 32+ character value, then rerun."
  exit 1
fi

step "Building the web SPA"
"${BUNX[@]}" vite build

step "Deploying Worker"
"${BUNX[@]}" wrangler deploy

cat <<'NEXT'

==> Executor deployed with trusted JWT authentication

  Configure WorkAgent with the same SPARK_TO_EXECUTOR_JWT_SECRET and add a Cloudflare
  service binding that targets this Worker. Tokens must use issuer "spark",
  audience "spark-executor", a user id in "sub", and a short expiration in
  "exp". The organization is fixed by SELF_HOSTED_ORG_ID.

  Spark tools are reached through the SPARK_TOOLS service binding. Executor
  signs each tool request with EXECUTOR_TO_SPARK_JWT_SECRET; Spark verifies the
  same secret name and value.

NEXT
