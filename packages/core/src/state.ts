// core/state.ts
// The only writer of entity state. Integrations report; the store compares, stamps, and emits.

import type { Database } from "bun:sqlite";
import { CoreError } from "./errors.ts";
import type { Attributes, Entity, EntityId, EntityState, EventBus, StateRecord } from "./types.ts";
import { deepEqual } from "./util.ts";

export interface StateStoreDeps {
  db: Database;
  registry: { getEntity(id: EntityId): Entity | undefined };
  bus: EventBus;
  now?: () => number;
}

/**
 * The state with the entity's chosen class written in; with none chosen, the integration's
 * own class stands.
 */
function classed(state: EntityState, entity: Entity): EntityState {
  if (state.domain !== "sensor" && state.domain !== "binary_sensor") return state;
  if (entity.deviceClass) return { ...state, deviceClass: entity.deviceClass } as EntityState;
  return state;
}

type LastStateRow = {
  entity_id: string;
  state: string;
  attributes: string | null;
  available: number;
  changed_at: number;
  updated_at: number;
};

export class StateStore {
  private readonly records = new Map<EntityId, StateRecord>();
  /** Each entity's state as its integration last said it, before a chosen class is written in. */
  private readonly reported = new Map<EntityId, EntityState>();
  private readonly now: () => number;
  private readonly upsert;
  private readonly remove;

  constructor(private readonly deps: StateStoreDeps) {
    this.now = deps.now ?? Date.now;
    this.upsert = deps.db.query(
      `INSERT INTO last_states (entity_id, state, attributes, available, changed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_id) DO UPDATE SET state = excluded.state, attributes = excluded.attributes,
         available = excluded.available, changed_at = excluded.changed_at, updated_at = excluded.updated_at`,
    );
    this.remove = deps.db.query("DELETE FROM last_states WHERE entity_id = ?");

    deps.bus.on("entity_removed", (e) => {
      this.records.delete(e.entity.id);
      this.reported.delete(e.entity.id);
      this.remove.run(e.entity.id);
    });
    // The registry has already moved the persisted rows to the new id.
    deps.bus.on("entity_renamed", (e) => {
      const record = this.records.get(e.oldId);
      if (!record) return;
      this.records.delete(e.oldId);
      this.records.set(e.entity.id, { ...record, entityId: e.entity.id });
      const reported = this.reported.get(e.oldId);
      this.reported.delete(e.oldId);
      if (reported) this.reported.set(e.entity.id, reported);
    });
    // A class chosen or cleared reads at once; the house did not change, so changedAt stays.
    deps.bus.on("entity_updated", (e) => {
      const old = this.records.get(e.entity.id);
      if (!old) return;
      const reported = this.reported.get(e.entity.id);
      if (!reported) return;
      const state = classed(reported, e.entity);
      if (deepEqual(old.state, state)) return;
      this.commit({ ...old, state }, old, true);
    });
  }

  /** Loads the last known state of every registered entity, unavailable until reported again. */
  restore(): void {
    const rows = this.deps.db.query<LastStateRow, []>("SELECT * FROM last_states").all();
    for (const row of rows) {
      const entityId = row.entity_id as EntityId;
      const entity = this.deps.registry.getEntity(entityId);
      if (!entity) continue;
      const reported = JSON.parse(row.state) as EntityState;
      this.reported.set(entityId, reported);
      this.records.set(entityId, {
        entityId,
        state: classed(reported, entity),
        attributes: row.attributes ? (JSON.parse(row.attributes) as Attributes) : undefined,
        available: false,
        changedAt: row.changed_at,
        updatedAt: row.updated_at,
      });
    }
  }

  get(id: EntityId): StateRecord | undefined {
    return this.records.get(id);
  }

  all(): StateRecord[] {
    return [...this.records.values()];
  }

  /**
   * The only entry point for state. Emits state_changed when the state, availability, or
   * attributes differ; an identical report is a heartbeat that only moves updatedAt.
   */
  report(
    integrationId: string,
    entityId: EntityId,
    reported: EntityState,
    attributes?: Attributes,
  ): void {
    const entity = this.owned(integrationId, entityId);
    if (reported.domain !== entity.domain) {
      throw new CoreError("invalid", `${entityId} is a ${entity.domain}, not a ${reported.domain}`);
    }

    this.reported.set(entityId, reported);
    const state = classed(reported, entity);
    const old = this.records.get(entityId);
    const at = this.now();
    const stateChanged = !old || !deepEqual(old.state, state);
    const record: StateRecord = {
      entityId,
      state: stateChanged ? state : old.state,
      attributes: attributes ?? old?.attributes,
      available: true,
      changedAt: stateChanged ? at : old.changedAt,
      updatedAt: at,
    };
    // Attributes are streamed too (a car's coordinates, say), though changedAt is about state alone.
    const attributesChanged = attributes !== undefined && !deepEqual(old?.attributes, attributes);
    this.commit(record, old, stateChanged || !old.available || attributesChanged);
  }

  setAvailable(integrationId: string, entityId: EntityId, available: boolean): void {
    this.owned(integrationId, entityId);
    const old = this.records.get(entityId);
    // Nothing is known about the entity yet; it becomes available with its first report.
    if (!old || old.available === available) return;
    this.commit({ ...old, available, updatedAt: this.now() }, old, true);
  }

  private commit(record: StateRecord, old: StateRecord | undefined, emit: boolean): void {
    this.records.set(record.entityId, record);
    // Stored as reported, so a class cleared after a restart falls back to the integration's.
    this.upsert.run(
      record.entityId,
      JSON.stringify(this.reported.get(record.entityId) ?? record.state),
      record.attributes ? JSON.stringify(record.attributes) : null,
      record.available ? 1 : 0,
      record.changedAt,
      record.updatedAt,
    );
    if (emit) {
      this.deps.bus.emit({ type: "state_changed", entityId: record.entityId, old, new: record });
    }
  }

  private owned(integrationId: string, entityId: EntityId): Entity {
    const entity = this.deps.registry.getEntity(entityId);
    if (!entity || entity.integrationId !== integrationId) {
      throw new CoreError("not_owner", `${integrationId} did not register ${entityId}`);
    }
    return entity;
  }
}
