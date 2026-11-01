import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "./controls.tsx";
import { AlertIcon, CalendarIcon, ParcelIcon, RuleIcon, SunIcon } from "./icons.tsx";

/** A button on a card. Variants are fixed per card type, from the canvas. */
export type CardAction = { key: string; label: string; onPress: () => void };

/** Tap the title (not a button) to talk about this item (MOM-7). */
type Selectable = { onSelect?: () => void; selected?: boolean };

function Title({ children, onSelect, small = false }: { children: ReactNode; onSelect?: (() => void) | undefined; small?: boolean }) {
  const cls = small ? "ds-card__title ds-card__title--small" : "ds-card__title";
  if (onSelect === undefined) return <p className={cls}>{children}</p>;
  return (
    <button type="button" className="ds-selectable" onClick={onSelect}>
      <span className={cls}>{children}</span>
    </button>
  );
}

function Actions({ actions, variants, large = false }: { actions: readonly CardAction[]; variants: readonly ButtonVariant[]; large?: boolean }) {
  if (actions.length === 0) return null;
  const last = variants.at(-1) ?? "ghost";
  return (
    <div className={large ? "ds-mode__actions" : "ds-card__actions"}>
      {actions.map((a, i) => (
        <Button key={a.key} variant={variants[i] ?? last} large={large} onClick={a.onPress}>
          {a.label}
        </Button>
      ))}
    </div>
  );
}

const selectedClass = (selected: boolean | undefined) => (selected === true ? " ds-selected" : "");

/** A calendar fact on its own (grey provenance): time, title, who. */
export function EventCard({ time, title, detail, onSelect, selected }: { time: string | null; title: string; detail: string } & Selectable) {
  return (
    <div className={`ds-card ds-card__row${selectedClass(selected)}`}>
      <div className="ds-card__lead">{time ?? <CalendarIcon size={22} />}</div>
      <div className="ds-card__main">
        <Title onSelect={onSelect}>{title}</Title>
        {detail === "" ? null : <p className="ds-card__detail">{detail}</p>}
      </div>
    </div>
  );
}

/** A white card holding rows divided by hairlines. */
export function ListCard({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="ds-card ds-card--list" role="list" aria-label={label}>
      {children}
    </div>
  );
}

export function EventRow({ time, title, detail, onSelect, selected }: { time: string | null; title: string; detail: string } & Selectable) {
  const text = (
    <>
      {title}
      {detail === "" ? null : <span className="ds-detail-inline"> · {detail}</span>}
    </>
  );
  return (
    <div className={`ds-list-row${selectedClass(selected)}`} role="listitem">
      <div className="ds-list-row__time">{time ?? ""}</div>
      {onSelect === undefined ? (
        <div className="ds-list-row__text">{text}</div>
      ) : (
        <button type="button" className="ds-selectable ds-list-row__text" onClick={onSelect}>
          {text}
        </button>
      )}
    </div>
  );
}

/** Parsed from order emails; never needs an action. */
export function ArrivalRow({ shop, when }: { shop: string; when: string }) {
  return (
    <div className="ds-list-row ds-list-row--compact" role="listitem">
      <ParcelIcon size={20} />
      <div className="ds-list-row__text ds-list-row__text--small">
        {shop}
        {when === "" ? null : <span className="ds-detail-inline"> · {when}</span>}
      </div>
    </div>
  );
}

/** Planner-made (green). Always carries its reason; dismiss with no guilt. */
export function SuggestionCard({ title, reason, actions, onSelect, selected }: { title: string; reason: string; actions: readonly CardAction[] } & Selectable) {
  return (
    <div className={`ds-card ds-card--suggestion ds-card__row${selectedClass(selected)}`}>
      <div className="ds-card__lead">
        <SunIcon size={26} tone="suggestion" />
      </div>
      <div className="ds-card__main">
        <Title onSelect={onSelect}>{title}</Title>
        <p className="ds-card__detail">{reason}</p>
      </div>
      {/* A lone action (e.g. only a dismiss) stays quiet; the solid button is for "do it". */}
      <Actions actions={actions} variants={actions.length === 1 ? ["suggestion-secondary"] : ["primary", "suggestion-secondary"]} />
    </div>
  );
}

/** Rule-derived (amber) — the only block allowed to be amber, with at most one action. */
export function AlertCard({ title, reason, action, onSelect, selected }: { title: string; reason: string; action: CardAction | null } & Selectable) {
  return (
    <div className={`ds-card ds-card--alert ds-card__row${selectedClass(selected)}`}>
      <div className="ds-card__lead">
        <AlertIcon size={24} tone="alert" />
      </div>
      <div className="ds-card__main">
        <Title onSelect={onSelect} small>
          {title}
        </Title>
        {reason === "" ? null : <p className="ds-card__detail">{reason}</p>}
      </div>
      {action === null ? null : <Actions actions={[action]} variants={["alert"]} />}
    </div>
  );
}

/** One undated backlog job that fits a gap: says when and why. */
export function BacklogPickCard({ title, reason, actions, onSelect, selected }: { title: string; reason: string; actions: readonly CardAction[] } & Selectable) {
  return (
    <div className={`ds-card ds-card--stack${selectedClass(selected)}`}>
      <Title onSelect={onSelect} small>
        {title}
      </Title>
      <p className="ds-card__detail">{reason}</p>
      <Actions actions={actions} variants={["secondary", "ghost"]} />
    </div>
  );
}

export type StillHappening = { id: string; text: string; provenance: "calendar" | "email" | "rule" | "planner" };

const STILL_ICON = {
  calendar: <CalendarIcon size={20} />,
  email: <ParcelIcon size={20} />,
  rule: <RuleIcon size={20} />,
  planner: <SunIcon size={20} />,
} as const;

/** Slow, sick or away: one suggested thing, then what is still happening anyway (MOM-1, MOM-5). */
export function ModeCard({
  eyebrow,
  title,
  why,
  actions,
  still,
  onSelect,
  selected,
}: {
  eyebrow: string;
  title: string | null;
  why: string;
  actions: readonly CardAction[];
  still: readonly StillHappening[];
} & Selectable) {
  return (
    <>
      <div className={`ds-card ds-card--focus${selectedClass(selected)}`}>
        <div className="ds-mode__eyebrow">{eyebrow}</div>
        {title === null ? null : onSelect === undefined ? (
          <p className="ds-mode__title">{title}</p>
        ) : (
          <button type="button" className="ds-selectable" onClick={onSelect}>
            <span className="ds-mode__title">{title}</span>
          </button>
        )}
        {why === "" ? null : <p className="ds-mode__why">{why}</p>}
        <Actions actions={actions} variants={["primary", "secondary", "ghost"]} large />
      </div>
      {still.length === 0 ? null : (
        <ul className="ds-still" aria-label="Still happening">
          {still.map((s) => (
            <li key={s.id} className="ds-still__item">
              {STILL_ICON[s.provenance]}
              <span>{s.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A backlog row: title plus one line of when or what it waits for. */
export function BacklogRow({ title, meta, tone = "muted", children }: { title: string; meta: string; tone?: "muted" | "suggestion"; children?: ReactNode }) {
  return (
    <div className="ds-list-row ds-list-row--stacked" role="listitem">
      <div className="ds-list-row__title">{title}</div>
      {meta === "" ? null : <div className={tone === "suggestion" ? "ds-list-row__meta ds-list-row__meta--suggestion" : "ds-list-row__meta"}>{meta}</div>}
      {children}
    </div>
  );
}

/** A plain card for settings groups, run logs and the like. */
export function Card({ children }: { children: ReactNode }) {
  return <div className="ds-card">{children}</div>;
}
