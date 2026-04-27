#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/data/gpt-cdk-g}"
BAK_DIR="${BAK_DIR:-/bak}"
APP_NAME="$(basename "$APP_DIR")"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_PATH="$BAK_DIR/$APP_NAME-$TIMESTAMP"

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: app directory not found: $APP_DIR" >&2
  exit 1
fi

if [ -e "$BACKUP_PATH" ]; then
  echo "ERROR: backup path already exists: $BACKUP_PATH" >&2
  exit 1
fi

mkdir -p "$BAK_DIR"

echo "Creating backup: $BACKUP_PATH"
cp -a "$APP_DIR" "$BACKUP_PATH"

echo "Backup completed: $BACKUP_PATH"
