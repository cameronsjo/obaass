#!/usr/bin/env bash
# Build the obaass-mcp image and check access tiers end to end in a container.
#
# Usage: mcp/scripts/docker-tier-smoke.sh [image-tag]
#
# Runs the image with throwaway full and limited tokens against a temp vault
# and asserts: the tool count each tier lists, a 401 without a token, and that
# the limited tier refuses an out-of-tier tool. Exits non-zero on any mismatch.
# Requires docker, curl, jq, and openssl. Generates its own tokens; nothing is
# read from or written to the caller's environment.
set -euo pipefail

IMAGE=${1:-obaass-mcp:tier-smoke}
MCP_DIR=$(cd "$(dirname "$0")/.." && pwd)
EXPECTED_FULL=16    # vault tools only: no BACKUP_URL or PLUGIN_MCP_URL is set
EXPECTED_LIMITED=12

for tool in docker curl jq openssl; do
	command -v "$tool" > /dev/null || { echo "FAIL: $tool is required" >&2; exit 2; }
done

FULL=$(openssl rand -hex 32)
LIMITED=$(openssl rand -hex 32)
VAULT=$(mktemp -d)
NAME="obaass-tier-smoke-$$"
cleanup() {
	docker rm -f "$NAME" > /dev/null 2>&1 || true
	rm -rf "$VAULT"
	return 0
}
trap cleanup EXIT
printf '# Hello\n' > "$VAULT/hello.md"
chmod -R a+rwX "$VAULT"

echo "Building $IMAGE from $MCP_DIR"
docker build -q -t "$IMAGE" "$MCP_DIR" > /dev/null

# The Host guard checks the authority a client used, so allow exactly the published one.
PORT=$((20000 + RANDOM % 20000))
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" -e MCP_ALLOWED_HOSTS="127.0.0.1:$PORT" \
	-e VAULT_PATH=/vault -e MCP_AUTH_TOKEN="$FULL" -e MCP_AUTH_TOKEN_LIMITED="$LIMITED" \
	-v "$VAULT:/vault" "$IMAGE" > /dev/null
URL="http://127.0.0.1:$PORT/mcp"

for _ in $(seq 1 30); do
	curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 && break
	sleep 1
done

# rpc <token-or-empty> <method> <params-json> -> prints "<http-status> <body>"
rpc() {
	local auth=()
	[[ -n "$1" ]] && auth=(-H "authorization: Bearer $1")
	local name
	name=$(jq -r ".name // empty" <<< "$3")
	[[ -n "$name" ]] && auth+=(-H "Mcp-Name: $name")
	local body
	body=$(jq -cn --arg m "$2" --argjson p "$3" '{jsonrpc:"2.0",id:1,method:$m,params:($p + {_meta:{
		"io.modelcontextprotocol/protocolVersion":"2026-07-28",
		"io.modelcontextprotocol/clientCapabilities":{},
		"io.modelcontextprotocol/clientInfo":{name:"tier-smoke",version:"1"}}})}')
	curl -sS -o /tmp/tier-smoke-body.$$ -w '%{http_code}' ${auth[@]+"${auth[@]}"} \
		-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
		-H 'MCP-Protocol-Version: 2026-07-28' -H "Mcp-Method: $2" \
		-d "$body" "$URL"
	printf ' '
	sed -n 's/^data: //p; /^{/p' /tmp/tier-smoke-body.$$ | tail -1
	rm -f /tmp/tier-smoke-body.$$
}

failures=0
check() { # label expected actual
	if [[ "$2" == "$3" ]]; then echo "PASS $1: $3"; else echo "FAIL $1: expected $2, got $3"; failures=$((failures + 1)); fi
}

read -r status body <<< "$(rpc "" tools/list '{}')"
check "no token" 401 "$status"

read -r status body <<< "$(rpc "$FULL" tools/list '{}')"
check "full tools/list status" 200 "$status"
check "full tool count" "$EXPECTED_FULL" "$(jq '.result.tools | length' <<< "$body")"

read -r status body <<< "$(rpc "$LIMITED" tools/list '{}')"
check "limited tools/list status" 200 "$status"
check "limited tool count" "$EXPECTED_LIMITED" "$(jq '.result.tools | length' <<< "$body")"

read -r status body <<< "$(rpc "$LIMITED" tools/call '{"name":"delete_note","arguments":{"path":"hello.md"}}')"
check "limited delete_note refused" "Tool delete_note not found" "$(jq -r '.error.message // "none"' <<< "$body")"
check "hello.md still present" yes "$([[ -f "$VAULT/hello.md" ]] && echo yes || echo no)"

logs=$(docker logs "$NAME" 2>&1)
if [[ "$logs" == *"$FULL"* || "$logs" == *"$LIMITED"* ]]; then
	check "no token value in container logs" absent present
else
	check "no token value in container logs" absent absent
fi

if [[ "$failures" -gt 0 ]]; then echo "$failures check(s) failed"; exit 1; fi
echo "All tier smoke checks passed"
