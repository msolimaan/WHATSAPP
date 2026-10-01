#!/bin/sh
# Hosting platforms mount volumes owned by root. Give the data folder to the
# unprivileged "node" user, then run the server as that user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
