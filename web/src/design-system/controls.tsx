import type { ReactNode } from "react";

export type ButtonVariant = "primary" | "suggestion-secondary" | "secondary" | "ghost" | "alert" | "ink" | "link";

/** Every button is at least 44×44 (HOME-10). */
export function Button({
  children,
  variant = "secondary",
  large = false,
  onClick,
  type = "button",
  disabled = false,
  label,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  large?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button type={type} className={`ds-button ds-button--${variant}${large ? " ds-button--large" : ""}`} onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
}

/** A tag chip: drawn at 32px like the canvas, with a 44px hit area. `on` false shows an addable tag. */
export function Chip({ children, on = true, onToggle, label }: { children: ReactNode; on?: boolean; onToggle?: () => void; label?: string }) {
  return (
    <button type="button" className={on ? "ds-chip" : "ds-chip ds-chip--off"} aria-pressed={on} onClick={onToggle} aria-label={label}>
      <span className="ds-chip__face">{children}</span>
    </button>
  );
}

export function Chips({ children }: { children: ReactNode }) {
  return <div className="ds-chips">{children}</div>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ds-toggle" onClick={() => onChange(!checked)}>
      <span className="ds-toggle__track" />
      <span className="ds-toggle__thumb" />
    </button>
  );
}

export function Stepper({ value, onChange, min, max, label, format = String }: { value: number; onChange: (next: number) => void; min: number; max: number; label: string; format?: (n: number) => string }) {
  return (
    <span className="ds-stepper" role="group" aria-label={label}>
      <Button variant="secondary" label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </Button>
      <span className="ds-stepper__value" aria-live="polite">
        {format(value)}
      </span>
      <Button variant="secondary" label={`More ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </Button>
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (next: T) => void; label: string }) {
  return (
    <span className="ds-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="ds-button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function TextInput({
  value,
  onChange,
  label,
  type = "text",
  placeholder,
  name,
  autoComplete,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  type?: "text" | "password" | "date";
  placeholder?: string;
  name?: string;
  autoComplete?: string;
}) {
  return (
    <input className="ds-text-input" aria-label={label} type={type} value={value} placeholder={placeholder} name={name} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} />
  );
}

/** A labelled settings row with its control on the right. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="ds-field">
      <span className="ds-field__label">
        {label}
        {hint === undefined ? null : <span className="ds-field__hint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export function Form({ children, onSubmit, label }: { children: ReactNode; onSubmit: () => void; label: string }) {
  return (
    <form
      className="ds-form"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
