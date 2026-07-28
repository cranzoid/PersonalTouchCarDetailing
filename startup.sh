#!/bin/sh
set -eu

# Prebuilt deployment artifacts contain Linux production dependencies in one
# archive. Refresh them only when that archive changes so restarts stay fast
# while deployments never reuse stale modules.
if [ -f node_modules.tar.gz ]; then
  archive_hash="$(sha256sum node_modules.tar.gz | cut -d ' ' -f 1)"
  installed_hash=""
  if [ -f node_modules/.ptcd-archive-sha256 ]; then
    installed_hash="$(cat node_modules/.ptcd-archive-sha256)"
  fi
  if [ ! -x node_modules/.bin/tsx ] || [ "$archive_hash" != "$installed_hash" ]; then
    rm -rf node_modules
    mkdir -p node_modules
    tar -xzf node_modules.tar.gz -C node_modules
    printf '%s\n' "$archive_hash" > node_modules/.ptcd-archive-sha256
  fi
fi

exec npm run start:azure
