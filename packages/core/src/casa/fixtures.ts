// casa/fixtures.ts
// A small house and the spec's stock Home page, for the compiler's and the runtime's tests.

import type { Registry } from "./check.ts";

export const REGISTRY: Registry = {
  entities: [
    { id: "weather.home", domain: "weather", name: "Home" },
    { id: "climate.living", domain: "climate", name: "Living thermostat" },
    { id: "sensor.living_temp", domain: "sensor", name: "Living temperature" },
    { id: "sensor.living_power", domain: "sensor", name: "Living power" },
    { id: "sensor.outside", domain: "sensor", name: "Outside" },
    { id: "light.hall", domain: "light", name: "Hall light" },
    { id: "light.living_lamp", domain: "light", name: "Living lamp" },
    { id: "switch.porch", domain: "switch", name: "Porch" },
    { id: "cover.garage", domain: "cover", name: "Garage door" },
    { id: "lock.front", domain: "lock", name: "Front door" },
    { id: "binary_sensor.hall_motion", domain: "binary_sensor", name: "Hall motion" },
    { id: "button.doorbell", domain: "button", name: "Doorbell" },
  ],
  areas: [
    { id: "living", name: "Living room" },
    { id: "hall", name: "Hall" },
    { id: "garage", name: "Garage" },
  ],
  devices: [
    { id: "dev_thermostat", name: "Thermostat" },
    { id: "dev_lamp", name: "Lamp" },
    { id: "dev_porch", name: "Porch switch" },
  ],
  icons: ["lightbulb", "thermometer", "lock", "gauge"],
};

/** Section 18 of the spec, as written there. */
export const HOME = `// A house theme both light and dark derive from, so \`palette.warn\` is covered everywhere.
theme House extends Day {
  palette { warn: #d9593a }
}
theme HouseNight extends Night {
  palette { warn: #e8755a }
}

// A temperature card that turns on the warning colour above a threshold and
// lets the viewer pick the history range.
component Temp(of: Entity, hot: Number = 25) {
  state range: Enum<Hour | Day | Week> = .Day
  Card {
    name: of.name
    accent: of.value > hot ? palette.warn : accents.sage
    Headline { of: of }
    History  { of: of  range: range  color: of.value > hot ? palette.warn : chart.series1 }
    Segmented {
      options: [.Hour, .Day, .Week]  labels: ["Hour", "Day", "Week"]
      value: range  onChange: (v) => set range = v
    }
  }
}

page Home {
  Stack {
    Greeting { weather: weather.home }
    Forecast { weather: weather.home  when: screen != .Phone }

    Grid {
      columns: screen == .Phone ? 1 : screen == .Tablet ? 2 : 3

      Area { of: area.living  name: area.living.name  icon: area.living.icon
        span: screen == .Desktop ? 2 : 1  facts: true
        Thermostat { of: climate.living }
        Temp { of: sensor.living_temp  hot: 26 }
        Card { name: "Lamps"  active: any(area.living.entities, (e) => e.domain == "light" && e.value == .On)
          for e in area.living.entities where e.domain == "light" {
            Toggle { of: e }
          }
        }
        Card { name: "Power"  size: .Sm
          Bar { of: sensor.living_power  target: 150  max: 600  color: sensor.living_power.value > 400 ? palette.warn : chart.good }
        }
      }

      // Every other room, generated: devices first, then entities with no device, by domain.
      for a in areas where a != area.living {
        Area { of: a  name: a.name  facts: true
          for d in a.devices {
            Card { name: d.name
              for e in d.entities { Row { of: e } }
            }
          }
        }
      }
    }

    Recent { limit: 10  when: screen != .Phone }
  }

  // Runs on the server, tab open or not.
  on switch.porch changed to .On {
    call light.hall.turn_on { brightness: 60% }
    after 10m { call light.hall.turn_off }
  }

  // Nightly, close anything left open.
  at 23:00 {
    if cover.garage.value == .Open { call cover.garage.close }
  }
}
`;
