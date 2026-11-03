import type { ReactNode } from "react";
import tokens from "../design/tokens.json";
import appIcon from "../src/assets/casita-app-icon.svg";
import mark from "../src/assets/casita-mark.svg";
import markNight from "../src/assets/casita-mark-night.svg";
import { ICON_NAMES, Icon } from "../src/index.ts";
import { Section } from "./section.tsx";

function Token({ name, usage, children }: { name: string; usage: string; children: ReactNode }) {
  return (
    <div className="g-card">
      {children}
      <div className="ca-text-entity-id">{name}</div>
      <p className="ca-text-caption g-note">{usage}</p>
    </div>
  );
}

export function Foundations() {
  return (
    <div className="g-tabs-pad">
      <Section title="Colour">
        <div className="g-grid">
          {tokens.color.tokens.map((token) => (
            <Token key={token.name} name={token.name} usage={token.usage}>
              <div className="g-swatch" style={{ background: `var(--${token.name})` }} />
            </Token>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <div className="g-card g-type">
          {tokens.type.groups.flatMap((group) =>
            group.styles.map((style) => [
              <span key={`${style.name}-name`} className="ca-text-entity-id">
                {style.name}
              </span>,
              <div key={style.name}>
                <div className={`ca-text-${style.name}`}>{style.sample}</div>
                <p className="ca-text-caption g-note">{style.usage}</p>
              </div>,
            ]),
          )}
        </div>
      </Section>

      <Section title="Space">
        <div className="g-grid">
          {tokens.spacing.tokens.map((token) => (
            <Token key={token.name} name={`${token.name} · ${token.value}`} usage={token.usage}>
              <div
                className="g-bar"
                style={{ width: `var(--${token.name})`, marginBottom: "var(--space-2)" }}
              />
            </Token>
          ))}
        </div>
      </Section>

      <Section title="Shape and elevation">
        <div className="g-grid">
          {tokens.radius.tokens.map((token) => (
            <Token key={token.name} name={`${token.name} · ${token.value}`} usage={token.usage}>
              <div
                className="g-shape"
                style={{
                  borderRadius:
                    token.name === "radius-arch"
                      ? `var(--${token.name}) var(--${token.name}) 0 0`
                      : `var(--${token.name})`,
                }}
              />
            </Token>
          ))}
          {tokens.shadow.tokens.map((token) => (
            <Token key={token.name} name={token.name} usage={token.usage}>
              <div
                className="g-shape"
                style={{
                  background: "var(--surface-raised)",
                  border: 0,
                  borderRadius: "var(--radius-md)",
                  boxShadow: `var(--${token.name})`,
                }}
              />
            </Token>
          ))}
        </div>
      </Section>

      <Section title="Logo">
        <div className="g-card g-logos">
          {[
            ["casita-mark.svg", mark],
            ["casita-mark-night.svg", markNight],
            ["casita-app-icon.svg", appIcon],
          ].map(([name, url]) => (
            <div key={name}>
              <img src={url} alt="" />
              <span className="ca-text-entity-id">{name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={`Icons · ${ICON_NAMES.length}`}>
        <div className="g-card g-icons">
          {ICON_NAMES.map((name) => (
            <div key={name} className="g-icon">
              <Icon name={name} size={24} />
              <span className="ca-text-caption">{name}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
