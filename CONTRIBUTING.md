# Contributing

This project is experimental. Describe implemented behavior precisely and keep
API examples executable. Do not claim novelty, security, recovery, or learning
effectiveness from a feature list alone.

## Three experience standards

- **Developers:** small typed APIs, useful defaults, actionable errors, and clear tests.
- **Agents:** discoverable capabilities, bounded outputs, stable references, and explicit recovery.
- **Customers:** truthful progress, understandable actions, continuity, and enforced access boundaries.

Explain meaningful tradeoffs among these standards in code reviews and documentation.

## Implementation

Keep domain behavior in adapters. Keep credentials out of prompts, workspaces,
transcripts, source files, screenshots, and recordings. Private evidence belongs
outside this repository. Production systems used for observation remain read-only.

Persist original evidence before projecting, compacting, or streaming it. Preserve
authoritative action outcomes. A restored transcript is not proof that an external
action was delivered; unresolved outcomes must remain explicit.

## Verification

Test observable behavior through public interfaces and real local runtime bindings.
Exercise interruptions, replay, revocation, concurrent updates, and late feedback.
Keep deterministic tests separate from real-model evaluations and deployed checks.
Generated documentation examples must compile and run against the implemented API.

After changing the graph codec or cell-global hardening, run `npm run runtime:generate`.
The generated source keeps sandbox execution independent of deploy-time function rewriting.
`npm run check` detects stale generated code and tests name-preserving and minified builds.

Public demos use real application flows and synthetic data. Record the revision,
show the causal sequence, and verify the exported video and rendered README.
