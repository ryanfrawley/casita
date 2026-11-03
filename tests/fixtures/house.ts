// A test-only integration shaped like a small house, for the human-facing CLI tests:
// a dimmable light, a lock that works and one that jams, a switch that never confirms,
// a thermostat, a CO2 sensor, and a read-only switch.

import { z } from "zod";
import { defineIntegration } from "../../packages/core/src/types.ts";

export default defineIntegration({
  id: "house",
  name: "Test house",
  version: "0",
  configSchema: z.strictObject({}),
  async setup(ctx) {
    const kitchen = ctx.registerDevice({ uniqueId: "kitchen", name: "Kitchen hub" });
    const doors = ctx.registerDevice({ uniqueId: "doors", name: "Door controller" });

    let brightness = 0.6;
    const ceiling = ctx.registerEntity(
      {
        uniqueId: "ceiling",
        domain: "light",
        name: "Ceiling light",
        slug: "k_ceiling",
        deviceId: kitchen.id,
        capabilities: { brightness: true },
      },
      async (command) => {
        if (command.action === "turn_on" && command.brightness !== undefined)
          brightness = command.brightness;
        ctx.reportState(ceiling.id, {
          domain: "light",
          on: command.action === "turn_on",
          brightness,
        });
      },
    );
    ctx.reportState(ceiling.id, { domain: "light", on: true, brightness });

    const kettle = ctx.registerEntity(
      {
        uniqueId: "kettle",
        domain: "switch",
        name: "Kettle",
        slug: "k_kettle",
        deviceId: kitchen.id,
      },
      async () => {}, // accepts the command; the device never reports back
    );
    ctx.reportState(kettle.id, { domain: "switch", on: false });

    const dishwasher = ctx.registerEntity({
      uniqueId: "dish",
      domain: "switch",
      name: "Dishwasher",
      slug: "k_dish",
      deviceId: kitchen.id,
    });
    ctx.reportState(dishwasher.id, { domain: "switch", on: true });

    const co2 = ctx.registerEntity({
      uniqueId: "co2",
      domain: "sensor",
      name: "Bedroom CO2",
      slug: "bedroom_co2",
    });
    ctx.reportState(co2.id, { domain: "sensor", value: 1140, unit: "ppm" });
    const office = ctx.registerEntity({
      uniqueId: "co2-office",
      domain: "sensor",
      name: "Office CO2",
      slug: "office_co2",
    });
    ctx.reportState(office.id, { domain: "sensor", value: 760, unit: "ppm" });

    const front = ctx.registerEntity(
      {
        uniqueId: "front",
        domain: "lock",
        name: "Front door",
        slug: "front_door",
        deviceId: doors.id,
      },
      async (command) => {
        ctx.reportState(front.id, { domain: "lock", locked: command.action === "lock" });
      },
    );
    ctx.reportState(front.id, { domain: "lock", locked: true });

    const gate = ctx.registerEntity(
      {
        uniqueId: "gate",
        domain: "lock",
        name: "Side gate lock",
        slug: "side_gate",
        deviceId: doors.id,
      },
      async () => {
        ctx.reportState(gate.id, { domain: "lock", locked: false, jammed: true });
      },
    );
    ctx.reportState(gate.id, { domain: "lock", locked: false });

    let target = 21;
    let mode: "off" | "heat" | "cool" | "auto" = "heat";
    const thermostat = ctx.registerEntity(
      {
        uniqueId: "hall",
        domain: "climate",
        name: "Hallway",
        slug: "hallway",
        capabilities: { tempRange: { min: 10, max: 30, step: 0.5 } },
      },
      async (command) => {
        if (command.action === "set_target") target = command.temp;
        else mode = command.mode;
        ctx.reportState(thermostat.id, {
          domain: "climate",
          mode,
          currentTemp: 21.5,
          targetTemp: target,
        });
      },
    );
    ctx.reportState(thermostat.id, {
      domain: "climate",
      mode,
      currentTemp: 21.5,
      targetTemp: target,
    });
  },
});
