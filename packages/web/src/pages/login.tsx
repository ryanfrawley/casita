import { Button, Icon, TextField } from "@casita/ui";
import mark from "@casita/ui/assets/casita-mark.svg";
import markNight from "@casita/ui/assets/casita-mark-night.svg";
import { type FormEvent, useEffect, useState } from "react";
import { useStore } from "../context.tsx";
import { isDark, savedTheme } from "../theme.ts";

/** Where a sign-in through an identity provider begins; it ends back here with a session. */
const oidcStart = (name: string) => `/api/auth/oidc/${encodeURIComponent(name)}/start?web=1`;

export function Login() {
  const store = useStore();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() =>
    new URLSearchParams(location.search).get("login") === "failed"
      ? "That sign-in didn't work. Try again, or ask whoever runs the house to check your account."
      : "",
  );
  const [providers, setProviders] = useState<{ name: string }[]>([]);
  useEffect(() => {
    fetch("/api/auth/providers")
      .then((response) => response.json())
      .then((body: { oidc?: { name: string }[] }) => setProviders(body.oidc ?? []))
      .catch(() => {});
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await store.login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in");
      setBusy(false);
    }
  };

  return (
    <main className="app-login">
      <form className="app-login-card" onSubmit={submit}>
        <div className="app-brand">
          <img src={isDark(savedTheme()) ? markNight : mark} alt="" />
          <span>Casita</span>
        </div>
        <h1 className="ca-text-title">Sign in</h1>
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? (
          <p className="app-login-error" role="alert">
            <Icon name="triangle-alert" size={16} />
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        {providers.map((provider) => (
          <a
            key={provider.name}
            className="ca-btn ca-btn-secondary ca-btn-md"
            href={oidcStart(provider.name)}
          >
            Sign in with {provider.name}
          </a>
        ))}
      </form>
    </main>
  );
}
