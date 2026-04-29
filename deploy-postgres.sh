#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
ENV_FILE="$APP_DIR/.env"
APP_URL="${APP_URL:-http://127.0.0.1:3000}"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "ERROR: docker compose or docker-compose is required." >&2
    exit 1
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    date +%s | sha256sum | awk '{print $1}'
  fi
}

get_env_value() {
  local key="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d '=' -f 2-
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  touch "$ENV_FILE"
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (done == 0) print key "=" value
    }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

ensure_env_value() {
  local key="$1"
  local default_value="$2"
  local current
  current="$(get_env_value "$key" || true)"
  if [ -z "$current" ]; then
    set_env_value "$key" "$default_value"
    echo "Set $key in .env"
  fi
}

wait_for_postgres() {
  local db_user="$1"
  local db_name="$2"
  local attempt
  for attempt in $(seq 1 60); do
    if compose exec -T postgres pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "ERROR: PostgreSQL did not become ready in time." >&2
  compose logs postgres >&2 || true
  exit 1
}

wait_for_app() {
  local attempt
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found; skipping app HTTP readiness check."
    return 0
  fi
  for attempt in $(seq 1 60); do
    if curl -fsS "$APP_URL/api/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "ERROR: app did not become ready at $APP_URL." >&2
  compose logs app >&2 || true
  exit 1
}

trigger_migration() {
  local admin_password="$1"
  local token
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found; skip automatic migration. Use the admin UI migration button instead."
    return 0
  fi

  token="$(
    curl -fsS "$APP_URL/api/admin/login" \
      -H 'Content-Type: application/json' \
      -d "{\"password\":\"$admin_password\"}" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
  )"

  if [ -z "$token" ]; then
    echo "Automatic admin login failed; use the admin UI migration button instead."
    return 0
  fi

  echo "Triggering JSON -> PostgreSQL migration..."
  curl -fsS "$APP_URL/api/admin/migrate-json-to-postgres" \
    -X POST \
    -H "X-Admin-Token: $token" \
    -H 'Content-Type: application/json'
  echo
}

main() {
  if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
    echo "ERROR: docker-compose.yml not found in $APP_DIR" >&2
    exit 1
  fi

  cd "$APP_DIR"
  mkdir -p "$APP_DIR/data"

  if [ ! -f "$ENV_FILE" ] && [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    echo "Created .env from .env.example"
  else
    touch "$ENV_FILE"
  fi

  ensure_env_value "POSTGRES_DB" "miao_gpt"
  ensure_env_value "POSTGRES_USER" "miao_gpt"

  local postgres_password
  postgres_password="$(get_env_value POSTGRES_PASSWORD || true)"
  if [ -z "$postgres_password" ] || [ "$postgres_password" = "change_this_postgres_password" ]; then
    postgres_password="$(generate_secret)"
    set_env_value "POSTGRES_PASSWORD" "$postgres_password"
    echo "Generated POSTGRES_PASSWORD in .env"
  fi

  local admin_password
  admin_password="$(get_env_value ADMIN_PASSWORD || true)"
  if [ -z "$admin_password" ] || [ "$admin_password" = "Asd=235689030466" ]; then
    admin_password="$(generate_secret)"
    set_env_value "ADMIN_PASSWORD" "$admin_password"
    echo "Generated ADMIN_PASSWORD in .env"
  fi

  ensure_env_value "ADMIN_PATH" "my-secret-admin-panel"
  ensure_env_value "TRUST_PROXY" "1"

  local db_name db_user db_url
  db_name="$(get_env_value POSTGRES_DB)"
  db_user="$(get_env_value POSTGRES_USER)"
  db_url="postgres://${db_user}:${postgres_password}@postgres:5432/${db_name}"
  set_env_value "DATABASE_URL" "$db_url"

  echo "Validating docker compose config..."
  compose config >/dev/null

  echo "Starting PostgreSQL..."
  compose up -d postgres
  wait_for_postgres "$db_user" "$db_name"

  echo "Building and starting app..."
  compose up -d --build app
  wait_for_app

  echo
  echo "Deployment is running."
  echo "Admin URL: ${APP_URL}/$(get_env_value ADMIN_PATH)"
  echo "Admin password is in: $ENV_FILE"
  echo

  if [ "${AUTO_MIGRATE:-}" = "1" ]; then
    trigger_migration "$admin_password"
  else
    echo "Next step: open the admin page -> 系统状态 -> click 迁移 JSON 数据到数据库."
    echo "To trigger migration automatically, run: AUTO_MIGRATE=1 bash deploy-postgres.sh"
  fi
}

main "$@"
