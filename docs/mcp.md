# MCP connections and the synthetic service

The reference app accepts remote MCP servers from the deployment's `MCP_ALLOWED_ORIGINS`
policy. Customers own their connections; workspace tool grants determine which capabilities
agents can discover and execute. Authorization credentials never enter the agent workspace.

1. Open **Connections**, enter an approved HTTPS endpoint, and select OAuth or a service token.
2. Complete OAuth as the connection owner. Inspect the reported scopes and unattended-access status.
3. Select the tools to grant. Imported tools require action approval by default.
4. On lost authorization, reconnect explicitly and resume the saved cell. An uncertain external
   write still needs reconciliation; reconnecting an account does not make a write safe to repeat.

The Cloudflare adapter reconstructs clients and uses encrypted storage for OAuth client metadata,
PKCE values, and rotating credentials. It refreshes and rediscovers the catalog before dispatch.
An incompatible schema fingerprint requires a new capability review.

## Run the synthetic service

`apps/mcp-fixture` is a separate test Worker with fictional part prices. It implements the MCP
and OAuth subset used by the demonstration. It is not an authorization server for production
accounts. It cannot place orders, access customer systems, or send supplier messages.

```sh
npm run setup -- --mcp-fixture --deployed
npx wrangler deploy --config apps/mcp-fixture/wrangler.jsonc \
  --secrets-file apps/mcp-fixture/.dev.vars.deployed
```

Set the fixture's `CALLBACK_ORIGINS` to your demo application origin, and the demo's
`MCP_ALLOWED_ORIGINS` to the fixture origin. Rebuild and deploy the demo after changing
its configuration. The connection endpoint is the fixture origin followed by `/mcp`.

The fixture issues 30-second access tokens and one-hour refresh tokens. Its operator-only
`POST /control` endpoint can expire an access token or revoke a synthetic grant. This supports
repeatable tests without waiting for a real customer's provider to fail.

```sh
npx tsx scripts/verify-mcp.ts \
  https://your-demo.account.workers.dev \
  https://your-mcp-fixture.account.workers.dev
```

The verifier uses isolated synthetic accounts. It tests real HTTPS authorization, approved
execution, an actual runtime restart, unattended refresh, provider revocation, and explicit
reconnection. It reads operator secrets from the ignored deployment files and retains only
synthetic results and assertions under `.wrangler/proofs`.
