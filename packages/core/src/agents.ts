import { RunBudgets } from "./budget.js";
import { encodeGraph, type ValueGraph } from "./codec.js";
import { invariant } from "./errors.js";
import { AccessPolicy } from "./policy.js";
import type {
  AuthorityDelegation,
  AuthorityScope,
  Principal,
  RecordStore,
  SourceRef,
} from "./types.js";

export interface AgentHandle {
  kind: "agent";
  id: string;
  rootId: string;
  workspaceId: string;
}
export interface AgentRecord extends AgentHandle {
  name: string;
  ownerId: string;
  parentId: string | null;
  scopes: AuthorityScope[];
  lineage: SourceRef[];
  status: "ready" | "running" | "completed" | "revoked";
  result?: ValueGraph;
}
export interface AgentMessage {
  id: string;
  agentId: string;
  senderId: string;
  value: ValueGraph;
  lineage: SourceRef[];
  createdAt: string;
  status: "pending" | "acknowledged";
}

/** Identities, narrowed authority, mailboxes and result handles survive process loss. */
export class AgentRegistry {
  private readonly policy: AccessPolicy;
  private readonly budgets: RunBudgets;
  constructor(private readonly store: RecordStore) {
    this.policy = new AccessPolicy(store);
    this.budgets = new RunBudgets(store);
  }
  create(
    parent: Principal,
    input: {
      id: string;
      name: string;
      rootId: string;
      workspaceId: string;
      scopes: AuthorityScope[];
      lineage?: SourceRef[];
    },
  ): AgentHandle {
    this.policy.require(parent, input.workspaceId, "read");
    invariant(
      input.scopes.length > 0 && input.scopes.length <= 20,
      "INVALID_INPUT",
      "Declare 1–20 named scopes for this agent.",
    );
    invariant(
      input.scopes.some(
        (scope) => scope.spaceId === input.workspaceId && scope.permissions.includes("read"),
      ),
      "INVALID_INPUT",
      "An agent needs read access to its own work context.",
    );
    invariant(
      parent.delegationId || input.id === input.rootId,
      "INVALID_INPUT",
      "A root agent uses its root-run identity.",
    );
    if (parent.delegationId)
      invariant(
        this.read(parent, parent.id).rootId === input.rootId,
        "ACCESS_DENIED",
        "Child work must share its parent's root budget.",
      );
    for (const scope of input.scopes)
      for (const permission of scope.permissions)
        this.policy.require(parent, scope.spaceId, permission);
    this.policy.requireSources(parent, input.lineage ?? []);
    return this.store.transaction(() => {
      const previous = this.store.get<AgentRecord>("agents", input.id);
      if (previous) {
        this.read(parent, input.id);
        invariant(
          previous.ownerId === parent.id &&
            previous.rootId === input.rootId &&
            previous.parentId === (parent.delegationId ?? null) &&
            previous.workspaceId === input.workspaceId &&
            JSON.stringify(previous.scopes) === JSON.stringify(input.scopes),
          "INVALID_INPUT",
          "This agent identity belongs to different work or authority.",
        );
        return this.handle(previous);
      }
      this.budgets.requireActive(input.rootId);
      if (parent.delegationId) this.budgets.addDescendant(input.rootId);
      const record: AgentRecord = {
        kind: "agent",
        id: input.id,
        name: input.name,
        rootId: input.rootId,
        workspaceId: input.workspaceId,
        ownerId: parent.id,
        parentId: parent.delegationId ?? null,
        scopes: input.scopes,
        lineage: [
          ...(input.lineage ?? []),
          ...input.scopes
            .filter((scope) => scope.permissions.includes("read"))
            .map((scope) => ({ spaceId: scope.spaceId, itemId: `agent-scope:${input.id}` })),
        ],
        status: "ready",
      };
      this.store.put("authority_delegations", record.id, {
        id: record.id,
        subjectId: record.id,
        deploymentId: parent.deploymentId,
        parent: { ...parent },
        scopes: record.scopes,
        revoked: false,
      } satisfies AuthorityDelegation);
      this.store.put("agents", record.id, record);
      return this.handle(record);
    });
  }
  principal(parent: Principal, id: string): Principal {
    const agent = this.read(parent, id);
    invariant(
      agent.ownerId === parent.id,
      "ACCESS_DENIED",
      "Only the authenticated parent can create this execution identity.",
    );
    const grant = this.store.get<AuthorityDelegation>("authority_delegations", id);
    invariant(grant && !grant.revoked, "ACCESS_DENIED", "This agent has no active authority.");
    return { id: grant.subjectId, deploymentId: grant.deploymentId, delegationId: id, roles: [] };
  }
  read(principal: Principal, id: string): AgentRecord {
    const record = this.store.get<AgentRecord>("agents", id);
    invariant(
      record && this.policy.visible(principal, record.workspaceId, record.lineage),
      "NOT_FOUND",
      "No accessible agent exists with that reference.",
    );
    return record;
  }
  list(principal: Principal, workspaceId: string): AgentRecord[] {
    this.policy.require(principal, workspaceId, "read");
    return this.store
      .list<AgentRecord>("agents")
      .filter(
        (agent) =>
          agent.workspaceId === workspaceId &&
          this.policy.visible(principal, workspaceId, agent.lineage),
      );
  }
  send(
    sender: Principal,
    agentId: string,
    input: { id: string; value: unknown; lineage: SourceRef[] },
  ): AgentMessage {
    const agent = this.read(sender, agentId);
    this.policy.require(sender, agent.workspaceId, "execute");
    this.policy.requireSources(sender, input.lineage);
    const recipient = this.principal(sender, agentId);
    this.policy.requireSources(recipient, input.lineage);
    this.policy.require(recipient, agent.workspaceId, "read");
    const value = encodeGraph({ value: input.value });
    invariant(
      JSON.stringify(value).length <= 64_000,
      "BUDGET_EXCEEDED",
      "Delegate large inputs using authorized artifact handles.",
    );
    return this.store.transaction(() => {
      const existing = this.store.get<AgentMessage>("agent_messages", input.id);
      if (existing) {
        invariant(
          existing.agentId === agentId &&
            existing.senderId === sender.id &&
            JSON.stringify(existing.value) === JSON.stringify(value),
          "INVALID_INPUT",
          "This message identity already has different content or recipients.",
        );
        return existing;
      }
      invariant(
        agent.status !== "completed" && agent.status !== "revoked",
        "INVALID_INPUT",
        "This agent has settled; create a new bounded task.",
      );
      this.budgets.requireActive(agent.rootId);
      const message: AgentMessage = {
        id: input.id,
        agentId,
        senderId: sender.id,
        value,
        lineage: [...agent.lineage, ...input.lineage],
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      this.store.put("agent_messages", message.id, message);
      this.store.put("agents", agent.id, { ...agent, status: "running" });
      return message;
    });
  }
  inbox(principal: Principal): AgentMessage[] {
    invariant(
      principal.delegationId === principal.id,
      "ACCESS_DENIED",
      "Read a mailbox through its authenticated agent identity.",
    );
    const agent = this.read(principal, principal.id);
    return this.store
      .list<AgentMessage>("agent_messages")
      .filter(
        (message) =>
          message.agentId === agent.id &&
          this.policy.visible(principal, agent.workspaceId, message.lineage),
      );
  }
  complete(principal: Principal, value: unknown, lineage: SourceRef[]): AgentHandle {
    invariant(
      principal.delegationId === principal.id,
      "ACCESS_DENIED",
      "Only the agent's authenticated execution can settle its result.",
    );
    const agent = this.read(principal, principal.id);
    this.policy.requireSources(principal, lineage);
    const result = encodeGraph({ value });
    invariant(
      JSON.stringify(result).length <= 64_000,
      "BUDGET_EXCEEDED",
      "Return an artifact handle for a large delegation result.",
    );
    return this.store.transaction(() => {
      if (agent.status === "completed") {
        invariant(
          JSON.stringify(agent.result) === JSON.stringify(result),
          "INVALID_INPUT",
          "A completed agent result is immutable.",
        );
        return this.handle(agent);
      }
      this.budgets.requireActive(agent.rootId);
      const sources = [
        ...agent.lineage,
        ...lineage,
        ...this.inbox(principal).flatMap((message) => message.lineage),
      ];
      this.store.put("agents", agent.id, {
        ...agent,
        status: "completed",
        result,
        lineage: sources,
      });
      for (const message of this.inbox(principal))
        this.store.put("agent_messages", message.id, { ...message, status: "acknowledged" });
      return this.handle(agent);
    });
  }
  revoke(principal: Principal, id: string): void {
    const agent = this.read(principal, id);
    invariant(
      principal.id === agent.ownerId || principal.roles.includes("developer"),
      "ACCESS_DENIED",
      "Only the owner or an authorized developer may revoke this agent.",
    );
    this.policy.require(principal, agent.workspaceId, "write");
    this.store.transaction(() => {
      const grant = this.store.get<AuthorityDelegation>("authority_delegations", id)!;
      this.store.put("authority_delegations", id, { ...grant, revoked: true });
      this.store.put("agents", id, { ...agent, status: "revoked" });
    });
  }
  private handle(agent: AgentRecord): AgentHandle {
    return { kind: "agent", id: agent.id, rootId: agent.rootId, workspaceId: agent.workspaceId };
  }
}
