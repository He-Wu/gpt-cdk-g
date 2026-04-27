#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/data/gpt-cdk-g}"

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

if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found in: $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

echo "Stopping existing docker compose service in $APP_DIR ..."
compose down --remove-orphans

echo "Building and starting docker compose service ..."
compose up -d --build

echo "Started successfully."
