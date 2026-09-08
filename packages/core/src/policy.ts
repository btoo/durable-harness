import { HarnessFault, invariant } from "./errors.js";
import type {
  AuthorityDelegation,
  KnowledgeSpace,
  Permission,
  Principal,
  RecordStore,
  SourceRef,
} from "./types.js";

/** Every lookup reads current grants. Persisted snapshots never freeze permissions. */
export class AccessPolicy {
  constructor(private readonly store: RecordStore) {}

  permits(principal: Principal, spaceId: string, permission: Permission): boolean {
    return this.permitsWithin(principal, spaceId, permission, new Set());
  }
  private permitsWithin(
    principal: Principal,
    spaceId: string,
    permission: Permission,
    visited: Set<string>,
  ): boolean {
    if (principal.delegationId) {
      if (visited.has(principal.delegationId) || visited.size >= 32) return false;
      visited.add(principal.delegationId);
      const grant = this.store.get<AuthorityDelegation>(
        "authority_delegations",
        principal.delegationId,
      );
      return (
        !!grant &&
        !grant.revoked &&
        grant.subjectId === principal.id &&
        grant.deploymentId === principal.deploymentId &&
        grant.scopes.some(
          (scope) => scope.spaceId === spaceId && scope.permissions.includes(permission),
        ) &&
        this.permitsWithin(grant.parent, spaceId, permission, visited)
      );
    }
    const space = this.store.get<KnowledgeSpace>("spaces", spaceId);
    return (
      !!space &&
      space.deploymentId === principal.deploymentId &&
      space.grants.some(
        (grant) => grant.principalId === principal.id && grant.permissions.includes(permission),
      )
    );
  }

  require(principal: Principal, spaceId: string, permission: Permission): void {
    if (!this.permits(principal, spaceId, permission))
      throw new HarnessFault(
        "ACCESS_DENIED",
        `This identity cannot ${permission} the requested workspace.`,
      );
  }

  requireSources(principal: Principal, sources: readonly SourceRef[]): void {
    for (const source of sources) this.require(principal, source.spaceId, "read");
  }

  visible(principal: Principal, spaceId: string, lineage: readonly SourceRef[]): boolean {
    return (
      this.permits(principal, spaceId, "read") &&
      lineage.every((source) => this.permits(principal, source.spaceId, "read"))
    );
  }

  setGrants(
    principal: Principal,
    spaceId: string,
    grants: KnowledgeSpace["grants"],
    expectedRevision: number,
  ): KnowledgeSpace {
    invariant(
      principal.roles.includes("developer"),
      "ACCESS_DENIED",
      "A developer must change access grants.",
    );
    this.require(principal, spaceId, "publish");
    return this.store.transaction(() => {
      const space = this.store.get<KnowledgeSpace>("spaces", spaceId)!;
      invariant(
        space.revision === expectedRevision,
        "STALE_REVISION",
        "Access changed while you were editing it. Reload the workspace.",
      );
      const updated = { ...space, grants, revision: space.revision + 1 };
      this.store.put("spaces", spaceId, updated);
      return updated;
    });
  }
}
