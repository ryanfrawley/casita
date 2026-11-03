// core/registry.ts
// Owns devices, entities and areas. SQLite is the store; the in-memory maps are the read path.

import type { Database } from "bun:sqlite";
import { CoreError } from "./errors.ts";
import type {
  Area,
  AreaId,
  Capabilities,
  Device,
  DeviceId,
  DeviceInput,
  Domain,
  Entity,
  EntityId,
  EntityInput,
  EventBus,
  RetentionPolicy,
} from "./types.ts";
import { BINARY_SENSOR_CLASSES, SENSOR_CLASSES } from "./types.ts";
import { deepEqual, slugify, uniqueSlug } from "./util.ts";

export const ALIAS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
/** A device id is a slug of its name, so Casa can say `device.thermostat`. */
export const DEVICE_ID = /^[a-z0-9_]+$/;

export interface RegistryDeps {
  db: Database;
  bus: EventBus;
  now?: () => number;
}

export type EntityPatch = {
  name?: string;
  /** null clears the override so the entity inherits its device's area again. */
  areaId?: AreaId | null;
  hidden?: boolean;
  disabled?: boolean;
  /** null clears the entity's own policy so the domain or default applies. */
  retention?: RetentionPolicy | null;
  /** null clears the chosen icon so the default shows again. */
  icon?: string | null;
  /** A sensor's class, or a binary sensor's; null goes back to the integration's. */
  deviceClass?: string | null;
};

export type DevicePatch = {
  name?: string;
  areaId?: AreaId | null;
  icon?: string | null;
};
export type AreaPatch = {
  name?: string;
  icon?: string | null;
};

/** A chosen icon, or undefined when the patch clears it or leaves it alone. */
const pickIcon = (patch: string | null | undefined, current: string | undefined) =>
  patch === undefined ? current : (patch ?? undefined);

/** The classes each kind of sensor may be given. */
export const ENTITY_CLASSES: Partial<Record<Domain, readonly string[]>> = {
  sensor: SENSOR_CLASSES,
  binary_sensor: BINARY_SENSOR_CLASSES,
};

/** A class the entity may take, null to clear it; anything else is refused. */
function classFor(entity: Entity, deviceClass: string | null): Entity["deviceClass"] | null {
  if (deviceClass === null) return null;
  const allowed = ENTITY_CLASSES[entity.domain];
  if (!allowed)
    throw new CoreError(
      "invalid",
      `${entity.id} is a ${entity.domain}; only a sensor or binary sensor has a class`,
    );
  if (!allowed.includes(deviceClass)) {
    throw new CoreError(
      "invalid",
      `${deviceClass} is not a ${entity.domain} class; one of ${allowed.join(", ")}`,
    );
  }
  return deviceClass as Entity["deviceClass"];
}

type DeviceRow = {
  id: string;
  unique_id: string;
  integration_id: string;
  name: string;
  name_by_user: number;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  area_id: string | null;
  via_device_id: string | null;
  orphaned: number;
  icon: string | null;
};

type EntityRow = {
  id: string;
  unique_id: string;
  integration_id: string;
  device_id: string | null;
  domain: string;
  name: string;
  name_by_user: number;
  capabilities: string;
  area_id: string | null;
  hidden: number;
  disabled: number;
  orphaned: number;
  retention: string | null;
  icon: string | null;
  device_class: string | null;
};

type Alias = { entityId: EntityId; expiresAt: number };

const uniqueKey = (integrationId: string, uniqueId: string) => `${integrationId}\0${uniqueId}`;
const flag = (value: boolean | undefined) => (value ? 1 : 0);

export class Registry {
  private readonly areas = new Map<AreaId, Area>();
  /** In the order they were made, so Home draws them in a steady order. */
  private devices = new Map<DeviceId, Device>();
  private readonly entities = new Map<EntityId, Entity>();
  private readonly deviceByUnique = new Map<string, DeviceId>();
  private readonly entityByUnique = new Map<string, EntityId>();
  private readonly aliases = new Map<EntityId, Alias>();
  /** Rows whose name the user set; integrations no longer overwrite it on discovery. */
  private readonly userNamed = new Set<string>();
  private readonly db: Database;
  private readonly bus: EventBus;
  private readonly now: () => number;

  constructor(deps: RegistryDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  // ───────── reads ─────────

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  getDevice(id: DeviceId): Device | undefined {
    return this.devices.get(id);
  }

  getArea(id: AreaId): Area | undefined {
    return this.areas.get(id);
  }

  listEntities(): Entity[] {
    return [...this.entities.values()];
  }

  listDevices(): Device[] {
    return [...this.devices.values()];
  }

  listAreas(): Area[] {
    return [...this.areas.values()];
  }

  /** The entity's own area, else its device's. */
  areaOf(entity: Entity): AreaId | undefined {
    if (entity.areaId) return entity.areaId;
    return entity.deviceId ? this.devices.get(entity.deviceId)?.areaId : undefined;
  }

  entitiesInArea(areaId: AreaId): Entity[] {
    return this.listEntities().filter((e) => this.areaOf(e) === areaId);
  }

  /** The current id when `id` is an unexpired rename alias. */
  aliasTarget(id: EntityId): EntityId | undefined {
    const alias = this.aliases.get(id);
    return alias && alias.expiresAt > this.now() ? alias.entityId : undefined;
  }

  // ───────── integration-facing registration ─────────

  /** Idempotent on (integrationId, uniqueId): a repeat call updates metadata and returns the same row. */
  registerDevice(integrationId: string, input: DeviceInput): Device {
    const key = uniqueKey(integrationId, input.uniqueId);
    const existingId = this.deviceByUnique.get(key);
    const existing = existingId ? this.devices.get(existingId) : undefined;
    const at = this.now();

    if (existing) {
      const next: Device = {
        ...existing,
        name: this.userNamed.has(existing.id) ? existing.name : input.name,
        manufacturer: input.manufacturer,
        model: input.model,
        firmware: input.firmware,
        viaDeviceId: input.viaDeviceId,
        orphaned: undefined,
      };
      if (deepEqual(existing, next)) return existing;
      this.saveDevice(next, at);
      this.bus.emit({ type: "device_updated", device: next });
      return next;
    }

    const device: Device = {
      id: this.allocateDeviceId(input.name),
      uniqueId: input.uniqueId,
      integrationId,
      name: input.name,
      manufacturer: input.manufacturer,
      model: input.model,
      firmware: input.firmware,
      viaDeviceId: input.viaDeviceId,
    };
    this.db
      .query(
        `INSERT INTO devices (id, unique_id, integration_id, name, manufacturer, model, firmware,
           via_device_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        device.id,
        device.uniqueId,
        integrationId,
        device.name,
        device.manufacturer ?? null,
        device.model ?? null,
        device.firmware ?? null,
        device.viaDeviceId ?? null,
        at,
        at,
      );
    this.devices.set(device.id, device);
    this.deviceByUnique.set(key, device.id);
    this.bus.emit({ type: "device_added", device });
    return device;
  }

  /** Idempotent on (integrationId, uniqueId). Allocates `<domain>.<slug>` on first sight. */
  registerEntity<D extends Domain>(integrationId: string, input: EntityInput<D>): Entity<D> {
    const key = uniqueKey(integrationId, input.uniqueId);
    const existingId = this.entityByUnique.get(key);
    const existing = existingId ? this.entities.get(existingId) : undefined;
    const capabilities: Capabilities = input.capabilities ?? {};
    const at = this.now();

    if (existing) {
      if (existing.domain !== input.domain) {
        throw new CoreError(
          "invalid",
          `${existing.id} is already registered as a ${existing.domain}, not a ${input.domain}`,
        );
      }
      const next: Entity = {
        ...existing,
        name: this.userNamed.has(existing.id) ? existing.name : input.name,
        deviceId: input.deviceId,
        capabilities,
        orphaned: undefined,
      };
      if (deepEqual(existing, next)) return existing as Entity<D>;
      this.saveEntity(next, at);
      this.bus.emit({ type: "entity_updated", entity: next });
      return next as Entity<D>;
    }

    const entity: Entity<D> = {
      id: this.allocateEntityId(input.domain, input.slug ?? input.name),
      uniqueId: input.uniqueId,
      domain: input.domain,
      integrationId,
      deviceId: input.deviceId,
      name: input.name,
      capabilities,
    };
    this.db
      .query(
        `INSERT INTO entities (id, unique_id, integration_id, device_id, domain, name, capabilities,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entity.id,
        entity.uniqueId,
        integrationId,
        entity.deviceId ?? null,
        entity.domain,
        entity.name,
        JSON.stringify(capabilities),
        at,
        at,
      );
    this.entities.set(entity.id, entity);
    this.entityByUnique.set(key, entity.id);
    this.bus.emit({ type: "entity_added", entity });
    return entity;
  }

  /** Removal by the owning integration (the device is gone for good). */
  removeEntity(integrationId: string, id: EntityId): void {
    const entity = this.entities.get(id);
    if (!entity || entity.integrationId !== integrationId) {
      throw new CoreError("not_owner", `${integrationId} did not register ${id}`);
    }
    this.dropEntity(entity);
  }

  /** Removal by the owning integration (the device left the network); its entities go with it. */
  removeDevice(integrationId: string, id: DeviceId): void {
    const device = this.devices.get(id);
    if (!device || device.integrationId !== integrationId) {
      throw new CoreError("not_owner", `${integrationId} did not register ${id}`);
    }
    this.dropDevice(device);
  }

  /** Flags everything owned by an instance that is not loaded; the UI can show and delete it. */
  markOrphans(loadedIntegrationIds: ReadonlySet<string>): void {
    const at = this.now();
    for (const device of this.listDevices()) {
      if (device.orphaned || loadedIntegrationIds.has(device.integrationId)) continue;
      const next = { ...device, orphaned: true };
      this.saveDevice(next, at);
      this.bus.emit({ type: "device_updated", device: next });
    }
    for (const entity of this.listEntities()) {
      if (entity.orphaned || loadedIntegrationIds.has(entity.integrationId)) continue;
      const next = { ...entity, orphaned: true };
      this.saveEntity(next, at);
      this.bus.emit({ type: "entity_updated", entity: next });
    }
  }

  // ───────── user-facing edits ─────────

  updateEntity(id: EntityId, patch: EntityPatch): Entity {
    const entity = this.requireEntity(id);
    if (typeof patch.areaId === "string") this.requireArea(patch.areaId);
    const next: Entity = {
      ...entity,
      name: patch.name ?? entity.name,
      areaId: patch.areaId === undefined ? entity.areaId : (patch.areaId ?? undefined),
      hidden: patch.hidden === undefined ? entity.hidden : patch.hidden || undefined,
      disabled: patch.disabled === undefined ? entity.disabled : patch.disabled || undefined,
      retention: patch.retention === undefined ? entity.retention : (patch.retention ?? undefined),
      icon: pickIcon(patch.icon, entity.icon),
      deviceClass:
        patch.deviceClass === undefined
          ? entity.deviceClass
          : (classFor(entity, patch.deviceClass) ?? undefined),
    };
    if (patch.name !== undefined) this.userNamed.add(id);
    this.saveEntity(next, this.now());
    this.bus.emit({ type: "entity_updated", entity: next });
    return next;
  }

  updateDevice(id: DeviceId, patch: DevicePatch): Device {
    const device = this.requireDevice(id);
    if (typeof patch.areaId === "string") this.requireArea(patch.areaId);
    const next: Device = {
      ...device,
      name: patch.name ?? device.name,
      areaId: patch.areaId === undefined ? device.areaId : (patch.areaId ?? undefined),
      icon: pickIcon(patch.icon, device.icon),
    };
    if (patch.name !== undefined) this.userNamed.add(id);
    this.saveDevice(next, this.now());
    this.bus.emit({ type: "device_updated", device: next });
    return next;
  }

  /**
   * Changes an entity's id. History follows the entity, and the old id stays reserved as an
   * alias for 30 days so stale references fail with a clear message.
   */
  renameEntity(id: EntityId, newId: EntityId): Entity {
    const entity = this.requireEntity(id);
    if (newId === id) return entity;
    if (!ENTITY_ID.test(newId) || newId.split(".")[0] !== entity.domain) {
      throw new CoreError("invalid", `New id must look like ${entity.domain}.<a-z0-9_>`);
    }
    // Renaming back to one of the entity's own former ids is allowed.
    const taken = this.entities.has(newId) || (this.aliasTarget(newId) ?? id) !== id;
    if (taken) throw new CoreError("invalid", `${newId} is already in use`);

    const next: Entity = { ...entity, id: newId };
    const expiresAt = this.now() + ALIAS_TTL_MS;
    this.db.transaction(() => {
      this.db
        .query("UPDATE entities SET id = ?, updated_at = ? WHERE id = ?")
        .run(newId, this.now(), id);
      for (const table of ["states", "last_states", "commands", "state_rollups"]) {
        this.db.query(`UPDATE ${table} SET entity_id = ? WHERE entity_id = ?`).run(newId, id);
      }
      this.db.query("DELETE FROM entity_aliases WHERE old_id = ?").run(newId);
      this.db.query("UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?").run(newId, id);
      this.db
        .query(
          "INSERT OR REPLACE INTO entity_aliases (old_id, entity_id, expires_at) VALUES (?, ?, ?)",
        )
        .run(id, newId, expiresAt);
    })();

    this.aliases.delete(newId);
    for (const alias of this.aliases.values()) {
      if (alias.entityId === id) alias.entityId = newId;
    }
    this.aliases.set(id, { entityId: newId, expiresAt });
    this.entities.delete(id);
    this.entities.set(newId, next);
    this.entityByUnique.set(uniqueKey(next.integrationId, next.uniqueId), newId);
    if (this.userNamed.delete(id)) this.userNamed.add(newId);
    this.bus.emit({ type: "entity_renamed", oldId: id, entity: next });
    return next;
  }

  /**
   * Changes a device's id; its entities and the devices behind it follow. There is no alias:
   * nothing is keyed by a device id except Casa sources, which recheck and name the unknown id.
   */
  renameDevice(id: DeviceId, newId: DeviceId): Device {
    const device = this.requireDevice(id);
    if (newId === id) return device;
    if (!DEVICE_ID.test(newId)) throw new CoreError("invalid", "New id must look like <a-z0-9_>");
    if (this.devices.has(newId)) throw new CoreError("invalid", `${newId} is already in use`);

    const next: Device = { ...device, id: newId };
    const at = this.now();
    this.db.transaction(() => {
      // entities.device_id references devices.id, so the parent row can only move with the
      // check held until commit.
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      this.db.query("UPDATE devices SET id = ?, updated_at = ? WHERE id = ?").run(newId, at, id);
      this.db.query("UPDATE entities SET device_id = ? WHERE device_id = ?").run(newId, id);
      this.db.query("UPDATE devices SET via_device_id = ? WHERE via_device_id = ?").run(newId, id);
    })();

    // The map keeps insertion order, which Home draws by; rebuild it rather than re-append.
    this.devices = new Map(
      [...this.devices.values()].map((d) => {
        const moved = d.id === id ? next : d.viaDeviceId === id ? { ...d, viaDeviceId: newId } : d;
        return [moved.id, moved];
      }),
    );
    this.deviceByUnique.set(uniqueKey(next.integrationId, next.uniqueId), newId);
    if (this.userNamed.delete(id)) this.userNamed.add(newId);
    for (const entity of this.listEntities()) {
      if (entity.deviceId === id) this.entities.set(entity.id, { ...entity, deviceId: newId });
    }
    this.bus.emit({ type: "device_renamed", oldId: id, device: next });
    return next;
  }

  /** Only orphaned entities can be deleted; a live integration would just register it again. */
  deleteEntity(id: EntityId): void {
    const entity = this.requireEntity(id);
    if (!entity.orphaned) throw new CoreError("invalid", `${id} is not orphaned`);
    this.dropEntity(entity);
  }

  /**
   * Only orphaned devices can be deleted (their entities go with them), or one with no entities
   * left: a live integration keeps at least one on a device it still knows, so an empty device
   * is a leftover nothing will register again.
   */
  deleteDevice(id: DeviceId): void {
    const device = this.requireDevice(id);
    const empty = !this.listEntities().some((e) => e.deviceId === id);
    if (!device.orphaned && !empty) {
      throw new CoreError("invalid", `${device.name} is not orphaned and still has entities`);
    }
    this.dropDevice(device);
  }

  /** Drops expired rename aliases, freeing those ids for reuse. */
  purgeExpiredAliases(): void {
    const at = this.now();
    this.db.query("DELETE FROM entity_aliases WHERE expires_at <= ?").run(at);
    for (const [oldId, alias] of this.aliases) {
      if (alias.expiresAt <= at) this.aliases.delete(oldId);
    }
  }

  // ───────── areas ─────────

  createArea(name: string): Area {
    const id = uniqueSlug(slugify(name), (candidate) =>
      this.areas.has(candidate as AreaId),
    ) as AreaId;
    const area: Area = { id, name };
    this.db
      .query("INSERT INTO areas (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, this.now());
    this.areas.set(id, area);
    this.bus.emit({ type: "area_added", area });
    return area;
  }

  updateArea(id: AreaId, patch: AreaPatch): Area {
    const current = this.requireArea(id);
    const area: Area = {
      id,
      name: patch.name ?? current.name,
      icon: pickIcon(patch.icon, current.icon),
    };
    this.db
      .query("UPDATE areas SET name = ?, icon = ? WHERE id = ?")
      .run(area.name, area.icon ?? null, id);
    this.areas.set(id, area);
    this.bus.emit({ type: "area_updated", area });
    return area;
  }

  deleteArea(id: AreaId): void {
    const area = this.requireArea(id);
    // ON DELETE SET NULL clears the references in SQLite; mirror that in memory.
    this.db.query("DELETE FROM areas WHERE id = ?").run(id);
    this.areas.delete(id);
    for (const device of this.listDevices()) {
      if (device.areaId !== id) continue;
      const next = { ...device, areaId: undefined };
      this.devices.set(device.id, next);
      this.bus.emit({ type: "device_updated", device: next });
    }
    for (const entity of this.listEntities()) {
      if (entity.areaId !== id) continue;
      const next = { ...entity, areaId: undefined };
      this.entities.set(entity.id, next);
      this.bus.emit({ type: "entity_updated", entity: next });
    }
    this.bus.emit({ type: "area_removed", area });
  }

  // ───────── internals ─────────

  private load(): void {
    for (const row of this.db
      .query<{ id: string; name: string; icon: string | null }, []>(
        "SELECT id, name, icon FROM areas",
      )
      .all()) {
      this.areas.set(row.id as AreaId, {
        id: row.id as AreaId,
        name: row.name,
        icon: row.icon ?? undefined,
      });
    }
    for (const row of this.db.query<DeviceRow, []>("SELECT * FROM devices").all()) {
      const device: Device = {
        id: row.id as DeviceId,
        uniqueId: row.unique_id,
        integrationId: row.integration_id,
        name: row.name,
        manufacturer: row.manufacturer ?? undefined,
        model: row.model ?? undefined,
        firmware: row.firmware ?? undefined,
        areaId: (row.area_id as AreaId | null) ?? undefined,
        viaDeviceId: (row.via_device_id as DeviceId | null) ?? undefined,
        orphaned: row.orphaned ? true : undefined,
        icon: row.icon ?? undefined,
      };
      this.devices.set(device.id, device);
      this.deviceByUnique.set(uniqueKey(device.integrationId, device.uniqueId), device.id);
      if (row.name_by_user) this.userNamed.add(device.id);
    }
    for (const row of this.db.query<EntityRow, []>("SELECT * FROM entities").all()) {
      const entity: Entity = {
        id: row.id as EntityId,
        uniqueId: row.unique_id,
        domain: row.domain as Domain,
        integrationId: row.integration_id,
        deviceId: (row.device_id as DeviceId | null) ?? undefined,
        name: row.name,
        capabilities: JSON.parse(row.capabilities) as Capabilities,
        areaId: (row.area_id as AreaId | null) ?? undefined,
        hidden: row.hidden ? true : undefined,
        disabled: row.disabled ? true : undefined,
        orphaned: row.orphaned ? true : undefined,
        retention: row.retention ? (JSON.parse(row.retention) as RetentionPolicy) : undefined,
        icon: row.icon ?? undefined,
        deviceClass: (row.device_class as Entity["deviceClass"] | null) ?? undefined,
      };
      this.entities.set(entity.id, entity);
      this.entityByUnique.set(uniqueKey(entity.integrationId, entity.uniqueId), entity.id);
      if (row.name_by_user) this.userNamed.add(entity.id);
    }
    const aliases = this.db
      .query<{ old_id: string; entity_id: string; expires_at: number }, []>(
        "SELECT * FROM entity_aliases",
      )
      .all();
    for (const row of aliases) {
      this.aliases.set(row.old_id as EntityId, {
        entityId: row.entity_id as EntityId,
        expiresAt: row.expires_at,
      });
    }
    this.purgeExpiredAliases();
  }

  private allocateEntityId(domain: Domain, proposal: string): EntityId {
    return uniqueSlug(`${domain}.${slugify(proposal)}`, (candidate) => {
      const id = candidate as EntityId;
      return this.entities.has(id) || this.aliasTarget(id) !== undefined;
    }) as EntityId;
  }

  private allocateDeviceId(name: string): DeviceId {
    return uniqueSlug(slugify(name), (candidate) =>
      this.devices.has(candidate as DeviceId),
    ) as DeviceId;
  }

  private saveDevice(device: Device, at: number): void {
    this.db
      .query(
        `UPDATE devices SET name = ?, name_by_user = ?, manufacturer = ?, model = ?, firmware = ?,
           area_id = ?, via_device_id = ?, orphaned = ?, icon = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        device.name,
        flag(this.userNamed.has(device.id)),
        device.manufacturer ?? null,
        device.model ?? null,
        device.firmware ?? null,
        device.areaId ?? null,
        device.viaDeviceId ?? null,
        flag(device.orphaned),
        device.icon ?? null,
        at,
        device.id,
      );
    this.devices.set(device.id, device);
  }

  private saveEntity(entity: Entity, at: number): void {
    this.db
      .query(
        `UPDATE entities SET name = ?, name_by_user = ?, device_id = ?, capabilities = ?, area_id = ?,
           hidden = ?, disabled = ?, orphaned = ?, retention = ?, icon = ?, device_class = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        entity.name,
        flag(this.userNamed.has(entity.id)),
        entity.deviceId ?? null,
        JSON.stringify(entity.capabilities),
        entity.areaId ?? null,
        flag(entity.hidden),
        flag(entity.disabled),
        flag(entity.orphaned),
        entity.retention ? JSON.stringify(entity.retention) : null,
        entity.icon ?? null,
        entity.deviceClass ?? null,
        at,
        entity.id,
      );
    this.entities.set(entity.id, entity);
  }

  private dropDevice(device: Device): void {
    for (const entity of this.listEntities()) {
      if (entity.deviceId === device.id) this.dropEntity(entity);
    }
    this.db.query("DELETE FROM devices WHERE id = ?").run(device.id);
    this.devices.delete(device.id);
    this.deviceByUnique.delete(uniqueKey(device.integrationId, device.uniqueId));
    this.userNamed.delete(device.id);
    this.bus.emit({ type: "device_removed", device });
  }

  private dropEntity(entity: Entity): void {
    this.db.query("DELETE FROM entities WHERE id = ?").run(entity.id);
    this.entities.delete(entity.id);
    this.entityByUnique.delete(uniqueKey(entity.integrationId, entity.uniqueId));
    this.userNamed.delete(entity.id);
    this.bus.emit({ type: "entity_removed", entity });
  }

  private requireEntity(id: EntityId): Entity {
    const entity = this.entities.get(id);
    if (entity) return entity;
    const renamedTo = this.aliasTarget(id);
    throw new CoreError(
      "not_found",
      renamedTo ? `${id} was renamed to ${renamedTo}` : `Unknown entity ${id}`,
    );
  }

  private requireDevice(id: DeviceId): Device {
    const device = this.devices.get(id);
    if (!device) throw new CoreError("not_found", `Unknown device ${id}`);
    return device;
  }

  private requireArea(id: AreaId): Area {
    const area = this.areas.get(id);
    if (!area) throw new CoreError("not_found", `Unknown area ${id}`);
    return area;
  }
}
