# Working on durable-harness

Read CONTRIBUTING.md before implementation. Optimize every change for developer,
agent, and customer experience. Keep code, API documentation, and demonstrations aligned.

Use TypeScript and npm workspaces. Keep Cloudflare integration behind an adapter.
Reproduce failures before fixing them, and verify the original path afterward.
Tests must assert behavior, not copies of implementation details.

Didero production is strictly read-only. Never include customer evidence or
credentials in this repository or the public demo. Use isolated synthetic data.

For browser verification in Codex Desktop, use the in-app browser and the
available Browser Use runtime. Follow the user's browser preferences before
using any fallback. Recordly is the requested application for demo recording.

Do not create a new Codex task or delegate work unless the user explicitly asks.
