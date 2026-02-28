#!/bin/sh
set -eu

# Fix volume permissions (runs as root, drops to obsidian after)
chown -R node:node /vault 2>/dev/null || true
chown -R node:node /home/node 2>/dev/null || true

# Everything below runs as the node user
exec su-exec node "$@"
