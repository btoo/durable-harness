# Deploy the synthetic experiment

Use isolated Cloudflare resources. Do not connect production ERP, email, or customer
datasets to the public demo.

## Requirements

- Workers Paid for deployed Dynamic Workers, starting at $5/month plus usage.
- R2 enabled and a private `durable-harness-artifacts` bucket.
- Wrangler permissions for these resources and a Workers subdomain.

Current cost references: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/), and
[the default model](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/).
Local deterministic tests do not invoke a model.

```sh
npx wrangler login
npx wrangler r2 bucket create durable-harness-artifacts --config apps/demo/wrangler.jsonc
npm run setup -- --deployed
npm run check
npm run build
npx wrangler deploy --config apps/demo/dist/durable_harness_demo/wrangler.json \
  --secrets-file apps/demo/.dev.vars.deployed
```

Deployment secrets are generated separately from local secrets and excluded from Git.
Vite copies local development secrets into its private server build directory for preview;
that directory is not the static asset directory. Never publish secret files or build
directories as recording assets.

Persona switching is limited to `DEMO_MODE=synthetic`. Browser sessions are signed and
HttpOnly. Real-model requests require `Authorization: Bearer <ADMIN_TOKEN>` and a
developer session. Never put tokens in URLs, recordings, prompts, or source files.

A model root is limited to eight steps, 48,000 reserved/reported tokens, two minutes
of active execution, and twelve descendant admissions. Paused approval waits do not
consume active time. Unknown interrupted usage remains reserved. This admission budget
is not a Cloudflare account spending cap.

`DH_REMOTE_MODELS=1 npm run dev` enables the development remote-binding proxy. Workers AI
is remote and may incur charges if called. Normal local exercises use deterministic
adapters. Deployed proof and real-model results belong in the implementation ledger.
