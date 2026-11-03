import { useState } from "react";
import {
  Badge,
  Button,
  ButtonGroup,
  Checkbox,
  CodeView,
  Combobox,
  CopyChip,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  MapView,
  Menu,
  PillGroup,
  RangeBar,
  ScaleBar,
  SegmentedControl,
  Select,
  Sheet,
  SideNav,
  Skeleton,
  Slider,
  StatusDot,
  Stepper,
  SunPath,
  Tabs,
  TextField,
  Timestamp,
  ToastRegion,
  Toggle,
  useToasts,
} from "../src/index.ts";
import { Demo } from "./section.tsx";

const ENTITIES = [
  {
    value: "light.kitchen_ceiling",
    label: "Ceiling light",
    description: "light.kitchen_ceiling",
    icon: "light",
  },
  { value: "lock.front_door", label: "Front door", description: "lock.front_door", icon: "lock" },
  { value: "cover.garage", label: "Garage door", description: "cover.garage", icon: "garage_door" },
  {
    value: "climate.hallway",
    label: "Hallway thermostat",
    description: "climate.hallway",
    icon: "climate",
  },
  {
    value: "sensor.attic_temp",
    label: "Attic temperature",
    description: "sensor.attic_temp",
    icon: "sensor",
    disabled: true,
  },
];

const ROWS = [
  { id: "light.kitchen_ceiling", name: "Ceiling light", area: "Kitchen", state: "On · 60%" },
  { id: "lock.front_door", name: "Front door", area: "Entry", state: "Locked" },
  { id: "cover.garage", name: "Garage door", area: "Garage", state: "Unavailable" },
];

const NOW = Date.now();

/** A toggle that behaves like a device: pending for a moment, then confirmed. */
function DeviceToggle({ label }: { label: string }) {
  const [on, setOn] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Toggle
      label={label}
      checked={on}
      pending={pending}
      onChange={(next) => {
        setPending(true);
        setTimeout(() => {
          setOn(next);
          setPending(false);
        }, 900);
      }}
    />
  );
}

function StepperDemo() {
  const [value, setValue] = useState(21);
  const [pending, setPending] = useState<number | null>(null);
  return (
    <Stepper
      label="Target temperature"
      value={value}
      pending={pending !== null}
      pendingValue={pending}
      min={10}
      max={30}
      step={0.5}
      unit="°"
      onChange={(next) => {
        setPending(next);
        setTimeout(() => {
          setValue(next);
          setPending(null);
        }, 900);
      }}
    />
  );
}

function Overlays() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [modal, setModal] = useState(false);
  const { toasts, push, dismiss } = useToasts();
  return (
    <>
      <div className="g-row g-wide">
        <Button variant="danger" icon="trash-2" onClick={() => setDialog(true)}>
          Remove device
        </Button>
        <Button onClick={() => setSheet(true)}>Open sheet</Button>
        <Button onClick={() => setModal(true)}>Open modal sheet</Button>
        <Button onClick={() => push({ message: "Saved", tone: "ok" })}>Toast: saved</Button>
        <Button
          onClick={() => {
            const id = push({ message: "Reloading zigbee2mqtt.main…", tone: "pending" });
            setTimeout(() => push({ id, message: "Reloaded zigbee2mqtt.main", tone: "ok" }), 1500);
          }}
        >
          Toast: pending, then done
        </Button>
        <Button
          onClick={() =>
            push({
              tone: "error",
              title: "Couldn't lock the front door",
              message: "The lock didn't respond. Check that the Z-Wave stick is connected.",
              action: { label: "Retry" },
            })
          }
        >
          Toast: error
        </Button>
      </div>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        tone="danger"
        title="Remove the garage door?"
        description="Its 3 entities and their history are removed. This can't be undone."
        actions={
          <>
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => setDialog(false)}>
              Remove
            </Button>
          </>
        }
      />
      <Sheet
        open={sheet || modal}
        modal={modal}
        onClose={() => {
          setSheet(false);
          setModal(false);
        }}
        title="Ceiling light"
        subtitle={<CopyChip value="light.kitchen_ceiling" />}
        width={480}
        footer={<Button variant="primary">Save</Button>}
      >
        <div className="g-col">
          <TextField label="Name" defaultValue="Ceiling light" />
          <Select
            label="Area"
            defaultValue="kitchen"
            options={[
              { value: "kitchen", label: "Kitchen" },
              { value: "entry", label: "Entry" },
            ]}
          />
          <Checkbox label="Hidden" hint="Left off dashboards; still usable in automations." />
        </div>
      </Sheet>
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

// Seattle's 5 October 2026, midnight to midnight, for the sun's demos.
const HOUR = 3_600_000;
const DAY = Date.UTC(2026, 9, 5, 7);

export function Components() {
  const [entity, setEntity] = useState("lock.front_door");
  const [nav, setNav] = useState("home");
  const [picked, setPicked] = useState<string[]>(["light.kitchen_ceiling"]);
  const all = picked.length === ROWS.length;

  return (
    <div className="g-tabs-pad">
      <Demo title="Button" note="One primary per view. Danger is never beside a terracotta fill.">
        <Button variant="primary" icon="plus">
          Add integration
        </Button>
        <Button>Secondary</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="danger" icon="trash-2">
          Remove
        </Button>
        <Button disabled>Disabled</Button>
        <Button size="sm" icon="refresh-cw">
          Reload
        </Button>
      </Demo>

      <Demo title="IconButton" note="The label is the tooltip and the accessible name.">
        <IconButton icon="pencil" label="Rename" />
        <IconButton icon="refresh-cw" label="Reload" variant="secondary" />
        <IconButton icon="eye" label="Show hidden" pressed />
        <IconButton icon="x" label="Close" size="sm" />
        <IconButton icon="trash-2" label="Remove" disabled />
      </Demo>

      <Demo title="Menu" note="Arrow keys move, Escape closes and returns focus.">
        <Menu
          label="Lamp actions"
          items={[
            { label: "Rename", icon: "pencil" },
            { label: "Reload", icon: "refresh-cw", hint: "zigbee2mqtt.main" },
            { label: "Disable", icon: "power", disabled: true },
            { type: "separator" },
            { type: "heading", label: "Danger" },
            { label: "Remove", icon: "trash-2", tone: "danger" },
          ]}
        />
        <Menu
          text="Add"
          icon="plus"
          variant="primary"
          align="start"
          items={[{ label: "Area" }, { label: "User" }]}
        />
      </Demo>

      <Demo title="Badge">
        <Badge>Neutral</Badge>
        <Badge tone="on">On</Badge>
        <Badge tone="ok">Running</Badge>
        <Badge tone="pending">Starting</Badge>
        <Badge tone="error">Error</Badge>
        <Badge tone="unavailable">Unavailable</Badge>
        <Badge tone="brand" icon="shield">
          Admin
        </Badge>
      </Demo>

      <Demo title="StatusDot" note="Hover or Tab for the word; online pulses.">
        <StatusDot status="online" detail="Last seen just now" align="start" />
        <StatusDot status="unavailable" detail="Last seen 2 h ago" />
        <StatusDot status="error" label="Jammed" />
        <StatusDot status="disabled" size="lg" placement="bottom" />
      </Demo>

      <Demo title="TextField, Select, Combobox">
        <div className="g-col">
          <TextField label="Name" defaultValue="Ceiling light" hint="What people call it." />
          <TextField
            label="Entity id"
            mono
            defaultValue="light.kitchen ceiling"
            error="Ids can't contain spaces."
          />
        </div>
        <div className="g-col">
          <Select
            label="Role"
            placeholder="Choose a role"
            options={[
              { value: "admin", label: "Admin" },
              { value: "member", label: "Member" },
              { value: "guest", label: "Guest" },
            ]}
          />
          <Combobox
            label="Entity"
            options={ENTITIES}
            value={entity}
            onChange={setEntity}
            mono
            hint="Type a name or an id."
          />
        </div>
      </Demo>

      <Demo
        title="Checkbox, Toggle, SegmentedControl, ButtonGroup, PillGroup"
        note="The toggle shows pending until the device confirms. A ButtonGroup segment with a confirmation arms on the first press and acts on the second."
      >
        <div className="g-col">
          <Checkbox label="Record history" defaultChecked />
          <Checkbox label="Hidden" hint="Left off dashboards." />
          <Checkbox label="Some selected" indeterminate />
          <Checkbox label="Disabled" disabled />
        </div>
        <div className="g-col">
          <DeviceToggle label="Porch light" />
          <Toggle label="Confirmed on" checked />
          <Toggle label="Unavailable" unavailable />
        </div>
        <div className="g-col">
          <SegmentedControl
            label="Access"
            defaultValue="read"
            options={[
              { value: "none", label: "None" },
              { value: "read", label: "Read" },
              { value: "control", label: "Control" },
            ]}
          />
          <ButtonGroup
            label="Garage doors"
            items={[
              { key: "left", label: "Left", active: true, confirm: "Close?", onPress: () => {} },
              { key: "middle", label: "Middle", pending: true, onPress: () => {} },
              { key: "right", label: "Right", confirm: "Open?", onPress: () => {} },
            ]}
          />
          <PillGroup
            label="Domain"
            allCount={42}
            options={[
              { value: "light", label: "Lights", icon: "light", count: 12 },
              { value: "switch", label: "Switches", icon: "switch", count: 8 },
              { value: "lock", label: "Locks", icon: "lock", count: 2 },
            ]}
          />
        </div>
      </Demo>

      <Demo title="Slider, Stepper, RangeBar">
        <div className="g-col">
          <Slider label="Brightness" defaultValue={60} />
          <Slider label="Blinds" tone="neutral" defaultValue={30} marks={[0, 50, 100]} />
          <Slider label="Brightness" value={40} pending />
          <Slider label="Brightness" value={40} level="read" />
          <Slider label="Brightness" value={40} unavailable />
        </div>
        <div className="g-col">
          <StepperDemo />
          <Stepper label="Minutes" value={10} min={0} max={10} size="sm" unit=" min" />
          <Stepper label="No reading" value={null} />
          <RangeBar
            from={12}
            to={24}
            min={5}
            max={30}
            marker={19}
            tone="ember"
            label="12° to 24°, now 19°"
          />
          <RangeBar from={2} to={9} min={-5} max={30} tone="sky" />
        </div>
      </Demo>

      <Demo title="Dialog, Sheet, Toast">
        <Overlays />
      </Demo>

      <Demo title="Tabs">
        <div className="g-wide">
          <Tabs
            label="History views"
            tabs={[
              { value: "charts", label: "Charts", icon: "activity" },
              { value: "logbook", label: "Logbook", icon: "history", count: 128 },
              { value: "export", label: "Export", disabled: true },
            ]}
          >
            {(value) => <p className="ca-text-body">The {value} panel.</p>}
          </Tabs>
        </div>
      </Demo>

      <Demo title="SideNav">
        <div className="g-stage" style={{ width: 240, height: 460 }}>
          <SideNav
            value={nav}
            onSelect={setNav}
            brand={<span className="g-name">Casita</span>}
            items={[
              { value: "home", label: "Home", icon: "house" },
              { value: "entities", label: "Entities", icon: "layout-grid", count: 42 },
              { value: "devices", label: "Devices", icon: "cpu" },
              { value: "areas", label: "Areas", icon: "map" },
              {
                value: "integrations",
                label: "Integrations",
                icon: "plug",
                alert: "1 integration has an error",
              },
              { value: "automations", label: "Automations", icon: "workflow" },
              { value: "history", label: "History", icon: "history" },
              { value: "users", label: "Users & access", icon: "users" },
              { value: "settings", label: "Settings", icon: "settings" },
            ]}
            footer={<span className="ca-text-caption">ryan · admin</span>}
          />
        </div>
      </Demo>

      <Demo
        title="DataTable"
        note="With Checkbox selection, CopyChip ids, Badge states and a row Menu."
      >
        <DataTable
          className="g-wide"
          caption="Entities"
          rows={ROWS}
          columns={[
            {
              key: "pick",
              label: "",
              width: 40,
              render: (row) => (
                <Checkbox
                  aria-label={`Select ${row.name}`}
                  checked={picked.includes(row.id)}
                  onChange={(on) =>
                    setPicked(on ? [...picked, row.id] : picked.filter((id) => id !== row.id))
                  }
                />
              ),
            },
            { key: "name", label: "Name" },
            { key: "id", label: "Id", render: (row) => <CopyChip value={row.id} /> },
            { key: "area", label: "Area" },
            {
              key: "state",
              label: "State",
              render: (row) => (
                <Badge
                  tone={
                    row.state === "Unavailable"
                      ? "unavailable"
                      : row.state === "Locked"
                        ? "ok"
                        : "on"
                  }
                >
                  {row.state}
                </Badge>
              ),
            },
            {
              key: "more",
              label: "",
              align: "right",
              render: () => (
                <Menu
                  size="sm"
                  items={[{ label: "Rename" }, { label: "Remove", tone: "danger" }]}
                />
              ),
            },
          ]}
        />
        <Checkbox
          label="Select all"
          checked={all}
          indeterminate={!all && picked.length > 0}
          onChange={(on) => setPicked(on ? ROWS.map((row) => row.id) : [])}
        />
      </Demo>

      <Demo title="Timestamp, CopyChip">
        <div className="g-col">
          <Timestamp value={NOW - 20_000} />
          <Timestamp value={NOW - 4 * 60_000} prefix="Updated" />
          <Timestamp value={NOW - 3 * 3_600_000} />
          <Timestamp value={NOW - 30 * 3_600_000} />
          <Timestamp value={NOW - 9 * 86_400_000} />
          <Timestamp value={NOW} format="datetime" />
        </div>
        <div className="g-col">
          <CopyChip value="light.kitchen_ceiling" />
          <CopyChip value="zigbee2mqtt/kitchen_ceiling/set" />
          <CopyChip value="4f9c2e7a-token" mono={false}>
            Kitchen tablet token
          </CopyChip>
        </div>
      </Demo>

      <Demo title="CodeView">
        <CodeView
          className="g-wide"
          title="Hall light"
          marks={[{ line: 3, tone: "error", message: "unknown entity `light.hallway_ceilng`" }]}
          code={`automation HallLight {
  on binary_sensor.hallway_motion changed to .On {
    call light.hallway_ceilng.turn_on
  }
}
`}
        />
      </Demo>

      <Demo
        title="MapView"
        note="A still map from OpenStreetMap's tiles; the pin points along a heading when there is one."
      >
        <div className="g-col">
          <MapView label="Car" latitude={47.6205} longitude={-122.3493} zoom={15} heading={45} />
        </div>
        <div className="g-col">
          <MapView label="Somewhere" height={120} />
        </div>
      </Demo>

      <Demo
        title="SunPath, ScaleBar"
        note="The sun walks its arc as the day goes; at night the arc waits. A scale's bands are equal in width, its reading lit with its word."
      >
        <div className="g-col">
          <SunPath
            label="The sun by day"
            rise="7:28 am"
            set="6:42 pm"
            dayStart={DAY}
            dayEnd={DAY + 24 * HOUR}
            riseAt={DAY + 7.47 * HOUR}
            setAt={DAY + 18.7 * HOUR}
            now={DAY + 14.5 * HOUR}
            latitude={47.6}
            longitude={-122.3}
            timeZone="America/Los_Angeles"
            headline="Sunset in 4h 12m"
            detail="11h 14m of daylight"
          />
          <SunPath
            label="The sun at night, place unknown"
            rise="7:28 am"
            set="6:42 pm"
            dayStart={DAY}
            dayEnd={DAY + 24 * HOUR}
            riseAt={DAY + 7.47 * HOUR}
            setAt={DAY + 18.7 * HOUR}
            now={DAY + 21.2 * HOUR}
            timeZone="America/Los_Angeles"
            headline="Sunrise in 10h 16m"
            detail="11h 14m of daylight"
          />
        </div>
        <div className="g-col">
          <ScaleBar
            label="UV index"
            value="0"
            bands={[
              { label: "Low", tone: 1 },
              { label: "Moderate", tone: 2 },
              { label: "High", tone: 3 },
              { label: "Very high", tone: 4 },
              { label: "Extreme", tone: 5 },
            ]}
            placed={{ band: 0, position: 0 }}
          />
          <ScaleBar
            label="PM2.5"
            value="21 µg/m³"
            bands={[
              { label: "Good", tone: 1 },
              { label: "Moderate", tone: 2 },
              { label: "Sensitive groups", tone: 3 },
              { label: "Unhealthy", tone: 4 },
              { label: "Very unhealthy", tone: 5 },
              { label: "Hazardous", tone: 6 },
            ]}
            placed={{ band: 1, position: 0.24 }}
          />
          <ScaleBar
            label="PM10"
            value="—"
            bands={[
              { label: "Good", tone: 1 },
              { label: "Moderate", tone: 2 },
              { label: "Sensitive groups", tone: 3 },
            ]}
          />
        </div>
      </Demo>

      <Demo title="EmptyState, Skeleton">
        <EmptyState
          title="No integrations yet"
          description="Add one to bring your devices in."
          icon="plug"
          actions={<Button variant="primary">Add integration</Button>}
        />
        <div className="g-col">
          <EmptyState size="inline" title="Nothing recorded in this range" icon="history" />
          <Skeleton lines={3} />
          <div className="g-row">
            <Skeleton shape="circle" width={36} height={36} />
            <Skeleton shape="block" width={160} height={36} />
          </div>
        </div>
      </Demo>
    </div>
  );
}
