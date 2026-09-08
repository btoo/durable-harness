# durable-harness

An experimental TypeScript harness for agents with durable programmable workspaces.

The project is investigating whether retained working data, reusable code, and
explicit recovery semantics can reduce the work of deploying and improving agents.

**Status: initial scaffold.** Runtime features and APIs are under development.
This commit establishes the public repository before feature implementation.

## Planned capabilities

- Durable code cells with retained named data, helper functions, and agent handles.
- Recoverable execution, searchable original history, and non-destructive compaction.
- Tenant isolation, explicit shared workspaces, and policy-controlled publication.
- Customer and developer views of the same live work.
- Remote MCP connections with managed authorization and reconnection.
- Feedback-driven, evaluated improvements to configuration and capabilities.
- A reference application, runnable API documentation, and a recorded demonstration.

The reference workflows use synthetic procurement and quoting data. Any private
observation of existing systems is read-only and excluded from public artifacts.

## Development principles

Every change is evaluated for developer, agent, and customer experience. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the implementation and verification standard.

## License

[MIT](LICENSE).
