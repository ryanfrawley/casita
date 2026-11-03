// Who may do what, as the Users page words it. Pure.

import type { Row } from "@casita/client";
import { DOMAIN_LABEL } from "./model.ts";
import type { House } from "./store.ts";

export type ScopeKind = "entity" | "area" | "domain";
export type Level = "none" | "read" | "control";
export type SubjectKind = "user" | "role";

export const ROLES = ["admin", "member", "guest"] as const;
export const roleLabel = (role: string): string => role.charAt(0).toUpperCase() + role.slice(1);

/** What a role may do with an entity no grant speaks of. */
export const ROLE_DEFAULT: Record<string, string> = {
  admin: "An admin can control everything; grants don't narrow that.",
  member: "A member can control everything unless a grant says otherwise.",
  guest: "A guest can see and do nothing unless a grant allows it.",
};

export const SCOPE_LABEL: Record<ScopeKind, string> = {
  entity: "Entity",
  area: "Area",
  domain: "Domain",
};

/** What a grant covers, by the name a person gave it; the id when the thing is gone. */
export function scopeName(house: House, kind: string, id: string): string {
  if (kind === "domain") return DOMAIN_LABEL[id] ?? id;
  const list = kind === "area" ? house.areas : house.entities;
  const found = list.find((item) => item.id === id);
  return found ? String(found.name) : id;
}

/** The things a grant of this kind can be about, for the picker. */
export function scopeOptions(
  house: House,
  kind: ScopeKind,
): { value: string; label: string; description?: string; icon?: string }[] {
  if (kind === "domain") {
    return Object.entries(DOMAIN_LABEL).map(([value, label]) => ({ value, label, icon: value }));
  }
  if (kind === "area") {
    return house.areas
      .map((area) => ({ value: String(area.id), label: String(area.name) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  return house.entities
    .map((entity) => ({
      value: String(entity.id),
      label: String(entity.name),
      description: String(entity.id),
      icon: String(entity.domain),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** A subject's grants, the most specific first: entities, then areas, then domains. */
export function grantsFor(grants: Row[], kind: SubjectKind, id: string): Row[] {
  const order = ["entity", "area", "domain"];
  return grants
    .filter((grant) => grant.subjectKind === kind && grant.subjectId === id)
    .sort(
      (a, b) =>
        order.indexOf(String(a.scopeKind)) - order.indexOf(String(b.scopeKind)) ||
        String(a.scopeId).localeCompare(String(b.scopeId)),
    );
}

/** What a new user's form gets wrong, by field. */
export function userDraftErrors(draft: {
  username: string;
  password: string;
}): Partial<Record<"username" | "password", string>> {
  const errors: Partial<Record<"username" | "password", string>> = {};
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(draft.username.trim())) {
    errors.username = "Letters, digits, dots, dashes and underscores.";
  }
  if (draft.password.length < 8) errors.password = "At least 8 characters.";
  return errors;
}

/** The API allows 80 characters; the form says so before it is sent. */
export const DISPLAY_NAME_MAX = 80;
export function displayNameError(draft: string): string | undefined {
  return draft.length > DISPLAY_NAME_MAX ? `At most ${DISPLAY_NAME_MAX} characters.` : undefined;
}

const AUDIT_WORDS: Record<string, string> = {
  login: "signed in",
  login_failed: "failed to sign in",
  logout: "signed out",
  user_created: "added the user",
  user_updated: "changed the user",
  user_deleted: "removed the user",
  grant_set: "set a grant",
  grant_deleted: "removed a grant",
  token_created: "made an API token",
  token_revoked: "revoked an API token",
  config_set: "set the config at",
};

/** One line of the audit log: who, did what, to what. */
export function auditLine(entry: Row, users: Row[]): { who: string; what: string; target: string } {
  const name = (id: unknown) => {
    const user = users.find((candidate) => candidate.id === id);
    return user ? String(user.username) : undefined;
  };
  const action = String(entry.action);
  const target = entry.target === undefined || entry.target === null ? "" : String(entry.target);
  return {
    // A failed sign-in has no user behind it, only the name that was tried.
    who: name(entry.actorUserId) ?? (action === "login_failed" ? target : "Someone"),
    what: AUDIT_WORDS[action] ?? action.replaceAll("_", " "),
    target: action === "login_failed" ? "" : (name(target) ?? target),
  };
}
