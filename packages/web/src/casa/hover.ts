// What the editor says of a reference under the pointer: the thing's name and a line or two
// about it from the house, or that the house has nothing by that id.

import { areaList, deviceList, entityView } from "../model.ts";
import type { House } from "../store.ts";
import type { Reference } from "./language.ts";

export interface HoverInfo {
  kind: Reference["kind"];
  id: string;
  /** Whether the house has it; an unknown one keeps its compiler error and cannot be opened. */
  found: boolean;
  title: string;
  lines: string[];
}

const WHAT: Record<Reference["kind"], string> = {
  entity: "entity",
  device: "device",
  area: "area",
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The reference described from the house as it stands now. */
export function describeReference(house: House, ref: Reference, now = Date.now()): HoverInfo {
  const missing = (): HoverInfo => ({
    kind: ref.kind,
    id: ref.id,
    found: false,
    title: ref.id,
    lines: [`No ${WHAT[ref.kind]} with this id is in the house.`],
  });
  const areaName = (areaId: unknown) =>
    typeof areaId === "string" ? house.areas.find((area) => area.id === areaId)?.name : undefined;
  switch (ref.kind) {
    case "entity": {
      const entity = house.entities.find((e) => e.id === ref.id);
      if (!entity) return missing();
      const view = entityView(house, entity, now);
      const area = areaName(entity.effectiveAreaId);
      const device = house.devices.find((d) => d.id === entity.deviceId)?.name;
      return {
        kind: "entity",
        id: ref.id,
        found: true,
        title: view.name,
        lines: [
          `${view.domain} · ${view.summary}`,
          [area ? `in ${area}` : null, device ? `on ${device}` : null].filter(Boolean).join(" · "),
        ].filter(Boolean),
      };
    }
    case "device": {
      const device = deviceList(house).find((d) => d.id === ref.id);
      if (!device) return missing();
      return {
        kind: "device",
        id: ref.id,
        found: true,
        title: device.name,
        lines: [
          device.maker,
          [
            device.area ? `in ${device.area}` : null,
            count(device.entities, "entity", "entities"),
            device.device.orphaned ? "orphaned" : device.status === "online" ? null : device.status,
          ]
            .filter(Boolean)
            .join(" · "),
        ].filter(Boolean),
      };
    }
    case "area": {
      const area = areaList(house).find((a) => a.id === ref.id);
      if (!area) return missing();
      return {
        kind: "area",
        id: ref.id,
        found: true,
        title: area.name,
        lines: [`${count(area.devices, "device")} · ${count(area.entities, "entity", "entities")}`],
      };
    }
  }
}
