# Rotate or roll back the MCP tokens

How to replace `MCP_AUTH_TOKEN` (`full`) or `MCP_AUTH_TOKEN_LIMITED` (`limited`) on the `mcp/` service, confirm which token a running server loaded, and roll back to an image from before access tiers.

The server holds one token per tier and reads them only at startup. A rotation is therefore a restart. Between the restart and the moment the client holding that tier's token is updated, that client gets HTTP 401. No overlap window exists.

## Prerequisites

- Shell access to wherever the service's environment is set (an untracked `.env`, a secret store, or the container definition).
- Access to update the client that holds the token: the gateway for `limited`, the MCP client config for `full`.
- `openssl` and `shasum` (or `sha256sum`) on the machine where you generate the token.

## Rotate one token

Rotate one tier at a time, `limited` first when both are due, in a window when a brief 401 for that tier's client is acceptable.

1. Generate the new value. Use a random source, never a passphrase:

   ```bash
   openssl rand -hex 32
   ```

2. Store it where the service reads its environment, replacing the old value of `MCP_AUTH_TOKEN_LIMITED` (or `MCP_AUTH_TOKEN`). The two values must differ, or the server refuses to start with `MCP_AUTH_TOKEN_LIMITED must differ from MCP_AUTH_TOKEN`.

3. Compute the new token's fingerprint, which you check against the startup log in step 5:

   ```bash
   printf 'obaass-mcp:token-fp:v1:%s' "$NEW_TOKEN" | shasum -a 256 | cut -c1-8
   ```

4. Restart the service, then update the client that holds this tier's token right away.

5. Confirm the server loaded the new token. Find the `Starting obaass-mcp` line in the service log. Its `tokenFingerprints` field lists `{tier, fingerprint}` per configured token. The entry for the rotated tier must equal the value from step 3. A mismatch means the service read a stale environment, so fix the environment and restart again.

6. Confirm the client works: a `tools/list` with the new token returns HTTP 200, and one with the old token returns 401.

To retire a tier entirely, unset its variable and restart. With neither token set and a non-loopback bind, the server refuses to start unless `MCP_ALLOW_UNAUTHENTICATED=true`, which serves only the anonymous read tools.

## Roll back to an image from before access tiers

An image from before access tiers ignores `MCP_AUTH_TOKEN_LIMITED`.

- **Both tokens set:** the old image starts and serves every tool to `MCP_AUTH_TOKEN`. The `limited` client gets 401 until you roll forward. Leave the variables in place.
- **Only `MCP_AUTH_TOKEN_LIMITED` set:** the old image sees no token and refuses to start on a non-loopback bind. Do not set `MCP_ALLOW_UNAUTHENTICATED=true` to get it up. On the old image that serves every read tool to anyone, including backup history and dot folders. Roll forward instead, or accept downtime for that client.
- **`MCP_ALLOW_UNAUTHENTICATED=true` set:** the old image serves every tool marked read-only, not just the anonymous set. Treat that as a wider exposure for the length of the rollback.

After a rollback, the startup line has no `tiers` field. Its presence is how to tell a tiered build is running.
