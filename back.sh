#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/data/gpt-cdk-g}"
BAK_DIR="${BAK_DIR:-/bak}"
APP_NAME="$(basename "$APP_DIR")"

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

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: app directory not found: $APP_DIR" >&2
  exit 1
fi

if [ ! -d "$BAK_DIR" ]; then
  echo "ERROR: backup directory not found: $BAK_DIR" >&2
  exit 1
fi

LATEST_BACKUP="$(find "$BAK_DIR" -maxdepth 1 -mindepth 1 -type d -name "$APP_NAME-*" | sort | tail -n 1)"

if [ -z "$LATEST_BACKUP" ]; then
  echo "ERROR: no backup directory found in $BAK_DIR for $APP_NAME." >&2
  exit 1
fi

if [ ! -f "$LATEST_BACKUP/docker-compose.yml" ]; then
  echo "ERROR: latest backup does not contain docker-compose.yml: $LATEST_BACKUP" >&2
  exit 1
fi

if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found in current app directory: $APP_DIR" >&2
  exit 1
fi

echo "Stopping current docker compose service in $APP_DIR ..."
cd "$APP_DIR"
compose down --remove-orphans

echo "Starting latest backup: $LATEST_BACKUP"
cd "$LATEST_BACKUP"
compose up -d --build

echo "Rollback started from: $LATEST_BACKUP"
