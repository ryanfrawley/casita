import "../src/styles/index.css";
import "./gallery.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import mark from "../src/assets/casita-mark.svg";
import markNight from "../src/assets/casita-mark-night.svg";
import { installFonts, SegmentedControl, Tabs } from "../src/index.ts";
import { Components } from "./components.tsx";
import { Foundations } from "./foundations.tsx";
import { House } from "./house.tsx";
import { Weather } from "./weather.tsx";

type Theme = "system" | "light" | "dark";

function Gallery() {
  const [theme, setTheme] = useState<Theme>("system");
  const [page, setPage] = useState(location.hash.slice(1) || "components");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const dark =
    theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <div className="g-page">
      <header className="g-top">
        <img src={dark ? markNight : mark} alt="" />
        <span className="g-name">Casita</span>
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={(value) => setTheme(value as Theme)}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Day" },
            { value: "dark", label: "Night" },
          ]}
        />
      </header>
      <Tabs
        label="Gallery"
        value={page}
        onChange={(value) => {
          setPage(value);
          history.replaceState(null, "", `#${value}`);
        }}
        tabs={[
          { value: "components", label: "Components" },
          { value: "house", label: "House and charts" },
          { value: "foundations", label: "Foundations" },
          { value: "weather", label: "Weather" },
        ]}
      >
        {(value) =>
          value === "foundations" ? (
            <Foundations />
          ) : value === "house" ? (
            <House />
          ) : value === "weather" ? (
            <Weather />
          ) : (
            <Components />
          )
        }
      </Tabs>
    </div>
  );
}

installFonts();
const root = document.getElementById("root");
if (root) createRoot(root).render(<Gallery />);
