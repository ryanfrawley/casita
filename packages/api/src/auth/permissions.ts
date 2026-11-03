// Permission resolution: a pure function over a user, the grants, and an entity.

export const ROLES = ["admin", "member", "guest"] as const;
export type Role = (typeof ROLES)[number];

export const LEVELS = ["none", "read", "control"] as const;
export type Level = (typeof LEVELS)[number];

export type SubjectKind = "user" | "role";
export type ScopeKind = "entity" | "area" | "domain";

export interface Grant {
  id: string;
  subjectKind: SubjectKind;
  subjectId: string;
  scopeKind: ScopeKind;
  scopeId: string;
  level: Level;
  createdBy?: string;
  createdAt: number;
}

/** What every role gets on an entity when no grant applies. */
export const ROLE_DEFAULT: Record<Role, Level> = {
  admin: "control",
  member: "control",
  guest: "none",
};

export interface PermissionSubject {
  id: string;
  role: Role;
}

/** The entity as permissions see it; `areaId` is the effective area (own, else the device's). */
export interface PermissionTarget {
  id: string;
  domain: string;
  areaId?: string;
}

export const atLeast = (level: Level, wanted: Level): boolean =>
  LEVELS.indexOf(level) >= LEVELS.indexOf(wanted);

/**
 * First match wins: user grant on the entity, its area, its domain; then role grant on the
 * entity, area, domain; then the role default.
 */
export function resolveLevel(
  user: PermissionSubject,
  grants: readonly Grant[],
  entity: PermissionTarget,
): Level {
  const scopes: [ScopeKind, string | undefined][] = [
    ["entity", entity.id],
    ["area", entity.areaId],
    ["domain", entity.domain],
  ];
  const subjects: [SubjectKind, string][] = [
    ["user", user.id],
    ["role", user.role],
  ];
  for (const [subjectKind, subjectId] of subjects) {
    for (const [scopeKind, scopeId] of scopes) {
      if (scopeId === undefined) continue;
      const grant = grants.find(
        (g) =>
          g.subjectKind === subjectKind &&
          g.subjectId === subjectId &&
          g.scopeKind === scopeKind &&
          g.scopeId === scopeId,
      );
      if (grant) return grant.level;
    }
  }
  return ROLE_DEFAULT[user.role];
}
