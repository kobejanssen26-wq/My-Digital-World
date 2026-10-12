#!/usr/bin/env bash
# My Digital World — cloud environment setup.
# Paste this ONE line into your Claude Code cloud environment's "Setup script":
#     curl -fsSL https://YOUR-DOMAIN/install-cloud.sh | bash
# and add the environment variables MDW_URL (https://YOUR-DOMAIN) and MDW_TOKEN (a bridge credential).
# This script only downloads the public hook file from your own dashboard and registers it as a user-level
# Claude Code hook inside the cloud VM. It never fails the session: on any error it prints a note and exits 0.
set -u
URL="${MDW_URL:-}"
if [ -z "$URL" ]; then
  # Fallback: the host this script was fetched from is not known to bash, so require MDW_URL.
  echo "mdw: MDW_URL is not set; skipping (add MDW_URL and MDW_TOKEN to the environment variables)"
  exit 0
fi
if [ -z "${MDW_TOKEN:-}" ]; then
  echo "mdw: MDW_TOKEN is not set; skipping"
  exit 0
fi
DIR="$HOME/.mdw-cloud"
mkdir -p "$DIR"
if curl -fsSL --max-time 20 "$URL/mdw-hook.js" -o "$DIR/mdw-hook.js"; then
  node "$DIR/mdw-hook.js" --install || echo "mdw: could not register hooks"
else
  echo "mdw: could not download $URL/mdw-hook.js (is the domain allowed in the environment's network settings?)"
fi
exit 0
