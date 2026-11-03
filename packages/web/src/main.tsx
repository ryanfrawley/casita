import "@casita/ui/styles.css";
import "./app.css";
import { CasitaClient } from "@casita/client";
import { installFonts } from "@casita/ui";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { createStore } from "./store.ts";
import { applyTheme, savedTheme } from "./theme.ts";

installFonts();
applyTheme(savedTheme());

// No token: the session cookie goes with the socket.
const store = createStore({ connect: () => CasitaClient.connect(location.origin) });
void store.start();

const root = document.getElementById("root");
if (root) createRoot(root).render(<App store={store} />);
