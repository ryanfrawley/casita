// Not in the design system yet: a grid to choose a picture for an entity, a device or an area.
import { useId, useState } from "react";
import { Icon, PICKABLE_ICONS, resolveIcon } from "../icon.tsx";
import { ICON_TAGS } from "../icon-tags.gen.ts";
import { cx } from "../util.ts";
import { FieldFoot } from "./field.tsx";

export interface IconPickerProps {
  label: string;
  /** The icon chosen; undefined is the default. */
  value?: string;
  /** What shows when nothing is chosen: an icon name, a domain, or a device kind. */
  fallback: string;
  /** Called with undefined when the default is chosen again. */
  onChange: (icon: string | undefined) => void;
  hint?: string;
  className?: string;
}

/** A radio group of icons, with the default as its first choice, so a choice can be undone. */
export function IconPicker({ label, value, fallback, onChange, hint, className }: IconPickerProps) {
  const id = useId();
  const chosen = value && resolveIcon(value) ? value : undefined;
  const shownDefault = resolveIcon(fallback) ?? "plug";
  const caption = chosen ? chosen : `The default, ${shownDefault}`;
  // The set is all of Lucide; a word narrows it by name or by the words Lucide tags an icon with,
  // so "couch" finds armchair. Icons matched by name come first. The chosen one always shows.
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const byName = (name: string) => words.every((word) => name.includes(word));
  const byTag = (name: string) => {
    const text = `${name} ${ICON_TAGS[name] ?? ""}`;
    return words.every((word) => text.includes(word));
  };
  const named = PICKABLE_ICONS.filter(byName);
  const tagged = PICKABLE_ICONS.filter((name) => !byName(name) && byTag(name));
  const shown: string[] = [...named, ...tagged];
  if (chosen && !shown.includes(chosen)) shown.push(chosen);
  const none = named.length + tagged.length === 0;
  return (
    <div className={cx("ca-field ca-icons", className)}>
      <span id={`${id}-l`} className="ca-field-label">
        {label}
      </span>
      <input
        type="search"
        className="ca-input ca-icons-search"
        placeholder="Find an icon"
        aria-label={`Find an icon for ${label}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        className="ca-icons-grid"
        role="radiogroup"
        aria-labelledby={`${id}-l`}
        aria-describedby={`${id}-d`}
      >
        <button
          type="button"
          role="radio"
          aria-checked={!chosen}
          title="Default"
          className={cx("ca-icons-opt ca-icons-default", !chosen && "ca-icons-on")}
          onClick={() => onChange(undefined)}
        >
          <Icon name={shownDefault} size={20} />
        </button>
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={chosen === name}
            title={name}
            className={cx("ca-icons-opt", chosen === name && "ca-icons-on")}
            onClick={() => onChange(name)}
          >
            <Icon name={name} size={20} />
          </button>
        ))}
        {none ? <span className="ca-icons-none">No icon named that.</span> : null}
      </div>
      <FieldFoot id={id} hint={hint ? `${caption}. ${hint}` : caption} />
    </div>
  );
}
