import { useState } from "react";
import {
  Area,
  Button,
  DeviceCard,
  DeviceSection,
  EntityCard,
  EntityRow,
  EntityTile,
  Forecast,
  IntegrationRow,
  LevelMeter,
  SceneButton,
  Slider,
  StateHistoryCard,
  StateTimeline,
  Thermostat,
  TimeSeriesCard,
  Toggle,
  WidgetCard,
} from "../src/index.ts";
import { Demo } from "./section.tsx";

const HOUR = 3_600_000;
/** A fixed day, so the charts read the same on every visit. */
const START = new Date(2026, 9, 4, 0, 0).getTime();
const END = START + 24 * HOUR;
const at = (hours: number) => START + hours * HOUR;

const indoor = Array.from({ length: 49 }, (_, i): [number, number | null] => {
  const hours = i / 2;
  // The sensor dropped off between 13:00 and 15:00.
  if (hours > 13 && hours < 15) return [at(hours), null];
  return [at(hours), 19.5 + 2 * Math.sin((hours - 9) / 3.8) + (hours > 17 ? 0.8 : 0)];
});
const target: [number, number][] = [
  [at(0), 18],
  [at(6.5), 21],
  [at(9), 19],
  [at(17), 21.5],
  [at(22.5), 18],
];
const outdoor = Array.from({ length: 25 }, (_, i): [number, number] => [
  at(i),
  11 + 6 * Math.sin((i - 9) / 3.8),
]);

/** A tile that behaves like a device: pending for a moment, then confirmed. */
function LiveTile() {
  const [state, setState] = useState<"on" | "off" | "pending">("off");
  const [next, setNext] = useState<"on" | "off">("on");
  return (
    <EntityTile
      name="Porch light"
      entityId="light.porch"
      domain="light"
      area="Entry"
      state={state}
      summary={state === "pending" ? (next === "on" ? "Turning on…" : "Turning off…") : undefined}
      brightness={0.8}
      onToggle={() => {
        if (state === "pending") return;
        const goal = state === "on" ? "off" : "on";
        setNext(goal);
        setState("pending");
        setTimeout(() => setState(goal), 900);
      }}
    />
  );
}

function LiveThermostat() {
  const [targetTemp, setTarget] = useState(21);
  const [pending, setPending] = useState<number | null>(null);
  const [mode, setMode] = useState("heat");
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  return (
    <Thermostat
      name="Hallway"
      area="Upstairs"
      entityId="climate.hallway"
      current={19.6}
      humidity={46}
      target={targetTemp}
      pendingTarget={pending}
      mode={mode as "heat"}
      pendingMode={pendingMode}
      action={mode === "heat" && targetTemp > 19.6 ? "heating" : "idle"}
      onTargetChange={(value) => {
        setPending(value);
        setTimeout(() => {
          setTarget(value);
          setPending(null);
        }, 900);
      }}
      onModeChange={(value) => {
        setPendingMode(value);
        setTimeout(() => {
          setMode(value);
          setPendingMode(null);
        }, 900);
      }}
    />
  );
}

export function House() {
  return (
    <div className="g-tabs-pad">
      <Demo
        title="EntityTile"
        note="Lit means on. Pending is a sky outline until the device confirms; unavailable is hatched."
      >
        <div className="g-tiles">
          <LiveTile />
          <EntityTile
            name="Ceiling light"
            entityId="light.kitchen_ceiling"
            domain="light"
            state="on"
            summary="On · 60%"
            brightness={0.6}
            area="Kitchen"
            onToggle={() => {}}
          />
          <EntityTile
            name="Front door"
            entityId="lock.front_door"
            domain="lock"
            state="off"
            summary="Locked"
            area="Entry"
            onToggle={() => {}}
          />
          <EntityTile
            name="Coffee maker"
            entityId="switch.coffee"
            domain="switch"
            state="pending"
            area="Kitchen"
            onToggle={() => {}}
          />
          <EntityTile
            name="Garage door"
            entityId="cover.garage"
            domain="cover"
            state="unavailable"
            summary="Unavailable · was Closed"
            area="Garage"
          />
          <EntityTile
            name="Attic"
            entityId="sensor.attic_temp"
            domain="sensor"
            state="off"
            summary="24.5 °C"
            level="read"
          />
        </div>
      </Demo>

      <Demo title="IntegrationRow">
        <div className="g-col">
          <IntegrationRow
            name="Zigbee2MQTT"
            integrationId="zigbee2mqtt.main"
            status="running"
            entities={42}
            since="since 9:02 am"
            onReload={() => {}}
          />
          <IntegrationRow
            name="ESPHome"
            integrationId="esphome.main"
            status="starting"
            entities={6}
          />
          <IntegrationRow
            name="Z-Wave JS"
            integrationId="zwave-js.main"
            status="error"
            error="Can't reach ws://localhost:3000. Check that zwave-js-server is running."
            onReload={() => {}}
          />
          <IntegrationRow name="Tesla" integrationId="tesla.main" status="stopped" />
        </div>
      </Demo>

      <Demo
        title="Area, DeviceCard, DeviceSection, EntityRow, EntityCard"
        note="An area is its heading and its cards on the page; the cards are the wells, sunken with no edge, their icons raised. What you act on is raised. Everything stands on a 72px pitch: 56px blocks with 16px gutters between them, inside a card and between cards alike, so a heading, a head, a row and a strip of stats are one unit and a card is a whole number of them. A device with one entity is an EntityCard: one row, with the control where the name is."
      >
        <div className="g-wide g-areas">
          <Area
            name="Garage"
            icon="garage_door"
            active
            subtitle="3 devices · 9 entities"
            areaId="garage"
            facts={[
              { label: "1 of 2 doors open", tone: "on" },
              { label: "Car charging · 72%", icon: "car" },
              { label: "1 device unavailable", tone: "unavailable" },
            ]}
            actions={<Button size="sm">Close all doors</Button>}
          >
            <DeviceCard
              name="Main door"
              icon="garage_door"
              active
              manufacturer="Ratgdo"
              model="v2.5"
              status="online"
              statusDetail="Last seen just now"
              deviceId="esphome.main:ratgdo-1"
              stats={[
                { label: "Opened", value: "2 min ago", icon: "timer" },
                { label: "Cycles", value: "1,204" },
              ]}
            >
              <EntityRow name="Door" domain="cover" icon="garage_door" state="on" summary="Open">
                <Button size="sm">Close</Button>
              </EntityRow>
              <EntityRow name="Light" domain="light" state="on" summary="On · 80%">
                <Toggle checked aria-label="Light" />
              </EntityRow>
              <EntityRow
                name="Obstruction"
                domain="binary_sensor"
                summary="Clear · 3 h"
                level="read"
              />
            </DeviceCard>
            <DeviceCard
              name="Side door"
              icon="garage_door"
              manufacturer="Ratgdo"
              status="unavailable"
              statusDetail="Last seen 2 h ago"
              error="The side door stopped answering. Check its power and Wi-Fi."
            >
              <EntityRow
                name="Door"
                domain="cover"
                icon="garage_door"
                state="unavailable"
                summary="Unavailable · was Closed"
              />
            </DeviceCard>
            <EntityCard
              name="Workbench lamp"
              icon="light"
              active
              summary="On · 60%"
              status="online"
              deviceId="zigbee2mqtt.main:0x1234"
              actions={
                <>
                  <Toggle checked aria-label="Workbench lamp" />
                  <Button variant="quiet" size="sm" icon="chevron-right" aria-label="Details" />
                </>
              }
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  minHeight: 56,
                  padding: "0 16px 0 68px",
                }}
              >
                <Slider ariaLabel="Workbench lamp brightness" value={60} />
              </div>
            </EntityCard>
            <DeviceCard
              name="Irrigation"
              icon="irrigation"
              active
              manufacturer="Rachio"
              model="3e"
              status="online"
              actions={
                <Button size="sm" variant="quiet">
                  Stop all
                </Button>
              }
              stats={[
                { label: "Watering", value: "1 of 3 zones" },
                { label: "Next run", value: "Tomorrow, 6:00 am", icon: "calendar-clock" },
              ]}
              footer="Firmware 2.4.1"
            >
              <DeviceSection title="Front lawn" summary="Watering · 8 min left" collapsible>
                <EntityRow name="Running" domain="switch" icon="valve" state="on" summary="On">
                  <Toggle checked aria-label="Front lawn running" />
                </EntityRow>
                <EntityRow name="Soil moisture" domain="sensor" icon="droplet" value="31%" />
              </DeviceSection>
              <DeviceSection title="Beds" summary="Idle" collapsible defaultOpen={false}>
                <EntityRow name="Running" domain="switch" icon="valve" summary="Off">
                  <Toggle aria-label="Beds running" />
                </EntityRow>
              </DeviceSection>
            </DeviceCard>
            <DeviceCard name="Lights" icon="light" model="1 of 2 on">
              <EntityRow name="Workbench" domain="light" state="on" summary="On · 40%">
                <Slider ariaLabel="Workbench brightness" defaultValue={40} />
              </EntityRow>
              <EntityRow name="Overhead" domain="light" summary="Off">
                <Toggle aria-label="Overhead" />
              </EntityRow>
            </DeviceCard>
          </Area>
          <Area name="Attic" subtitle="No devices" collapsible />
        </div>
      </Demo>

      <Demo
        title="WidgetCard"
        note="A device's card as the household arranged it: a headline, a bar with a target, stats, and rows. The accent colours the lit icon, 'Card colour' bars and toggles."
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 340px)", gap: 16 }}>
          <WidgetCard
            name="Model Y"
            icon="car"
            accent="sage"
            active
            status="Parked · Locked"
            deviceId="dev_model_y"
            blocks={[
              { kind: "headline", key: "range", value: "348", unit: "km", caption: "Range" },
              {
                kind: "bar",
                key: "battery",
                label: "Battery",
                value: "72%",
                percent: 72,
                tone: "accent",
                marker: { percent: 80, text: "charge limit 80%" },
              },
              {
                kind: "stats",
                key: "stats",
                stats: [
                  { key: "full", label: "Full by", value: "11:40 pm", icon: "timer" },
                  { key: "inside", label: "Inside", value: "24.5 °C", icon: "thermometer" },
                ],
              },
              {
                kind: "row",
                key: "charging",
                children: (
                  <EntityRow name="Charging" domain="switch" state="on" summary="On · 11 kW">
                    <Toggle aria-label="Charging" defaultChecked />
                  </EntityRow>
                ),
              },
            ]}
          />
          <WidgetCard
            name="Irrigation"
            icon="irrigation"
            accent="sky"
            size="sm"
            status="Watering Lawn · 6 min left"
            blocks={[
              {
                kind: "bar",
                key: "soil",
                label: "Lawn soil",
                value: "21%",
                percent: 21,
                tone: "sky",
                low: true,
              },
              {
                kind: "row",
                key: "lawn",
                children: (
                  <EntityRow name="Lawn" domain="switch" state="on" summary="Watering">
                    <Toggle aria-label="Lawn" defaultChecked />
                  </EntityRow>
                ),
              },
            ]}
          />
          <WidgetCard name="Porch plug" icon="plug" blocks={[]} />
        </div>
      </Demo>

      <Demo
        title="TimeSeriesCard"
        note="Measured is series-1; the target is series-2, stepped. Gaps are hatched, never smoothed. Hover or use the arrow keys."
      >
        <TimeSeriesCard
          className="g-wide"
          title="Hallway temperature"
          subtitle="Sun 4 Oct"
          unit="°"
          xDomain={[START, END]}
          series={[
            { label: "Inside", points: indoor },
            { label: "Target", points: target, step: true },
            { label: "Outside", points: outdoor },
          ]}
          bands={[
            { from: at(6.5), to: at(8), tone: "heat", label: "Heating" },
            { from: at(17), to: at(19), tone: "heat", label: "Heating" },
            { from: at(13), to: at(15), tone: "unavailable", label: "Unavailable" },
          ]}
        />
      </Demo>

      <Demo title="StateHistoryCard, StateTimeline">
        <StateHistoryCard
          className="g-wide"
          title="Lights"
          subtitle="Sun 4 Oct"
          xDomain={[START, END]}
          rows={[
            {
              label: "Ceiling light",
              segments: [
                { from: at(0), to: at(6.5), state: "off" },
                { from: at(6.5), to: at(8.2), state: "on" },
                { from: at(8.2), to: at(18), state: "off" },
                { from: at(18), to: at(23), state: "on" },
                { from: at(23), state: "off" },
              ],
            },
            {
              label: "Porch light",
              segments: [
                { from: at(0), to: at(7), state: "on" },
                { from: at(7), to: at(12), state: "off" },
                { from: at(12), to: at(14.5), state: "unavailable" },
                { from: at(14.5), to: at(19), state: "off" },
                { from: at(19), state: "on" },
              ],
            },
          ]}
        />
        <div className="g-wide">
          <StateTimeline
            label="Front door"
            axis
            xDomain={[START, END]}
            states={{
              locked: { label: "Locked", tone: "ok" },
              unlocked: { label: "Unlocked", tone: "on" },
            }}
            segments={[
              { from: at(0), to: at(7.5), state: "locked" },
              { from: at(7.5), to: at(7.8), state: "unlocked" },
              { from: at(7.8), to: at(17.4), state: "locked" },
              { from: at(17.4), to: at(18), state: "unlocked" },
              { from: at(18), state: "locked" },
            ]}
          />
        </div>
      </Demo>

      <Demo title="LevelMeter">
        <div className="g-col">
          <LevelMeter
            label="Car battery"
            entityId="sensor.car_battery"
            value={72}
            target={80}
            targetLabel="Limit"
            status="Charging"
          />
          <LevelMeter label="Lock battery" value={12} low={20} />
        </div>
        <div className="g-col">
          <LevelMeter label="Humidity" value={46} target={45} />
          <LevelMeter label="Water tank" value={null} />
        </div>
      </Demo>

      <Demo
        title="Thermostat, SceneButton, Forecast"
        note="Exemplars: built only from base components."
      >
        <div className="g-col">
          <LiveThermostat />
          <Thermostat
            name="Bedroom"
            current={18.2}
            target={18}
            mode="cool"
            action="cooling"
            level="read"
          />
        </div>
        <div className="g-col">
          <SceneButton
            name="Good night"
            description="Locks up and turns everything off"
            icon="moon"
            lastRun={Date.now() - 20 * HOUR}
          />
          <SceneButton name="Movie time" state="running" />
          <SceneButton name="Away" state="error" error="The garage door didn't close" />
          <Forecast
            title="Forecast"
            current={{ temperature: 17.4, condition: "partly-cloudy", high: 19, low: 9 }}
            days={[
              { label: "Today", condition: "partly-cloudy", low: 9, high: 19 },
              { label: "Mon", condition: "rain", low: 8, high: 14, precip: 80 },
              { label: "Tue", condition: "cloudy", low: 7, high: 15, precip: 20 },
              { label: "Wed", condition: "clear", low: 6, high: 20 },
            ]}
          />
        </div>
      </Demo>
    </div>
  );
}
