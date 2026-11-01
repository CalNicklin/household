import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./controls.tsx";
import { CloseIcon } from "./icons.tsx";

/**
 * CAP-6: shared lists. A card per list: its title (with a menu), its items in order, and a line to add
 * one. Ticked items stay on the list, struck through. Every control is at least 44×44 (HOME-10).
 */
export function ChecklistCard({ label, title, children, adder }: { label: string; title: ReactNode; children: ReactNode; adder: ReactNode }) {
  return (
    <section className="ds-card ds-checklist" aria-label={label}>
      {title}
      <div className="ds-checklist__items" role="list" aria-label={`${label} items`}>
        {children}
      </div>
      <div className="ds-checklist__adder">{adder}</div>
    </section>
  );
}

export function ChecklistTitle({ emoji, name, menu }: { emoji: string; name: string; menu: ReactNode }) {
  return (
    <div className="ds-checklist__head">
      <h2 className="ds-checklist__title">
        <span aria-hidden="true">{emoji}</span> {name}
      </h2>
      {menu}
    </div>
  );
}

/** Rename a list and change its emoji in place. Enter saves, Escape puts it back. */
export function ChecklistTitleEditor({ emoji, name, onSave, onCancel }: { emoji: string; name: string; onSave: (next: { emoji: string; name: string }) => void; onCancel: () => void }) {
  const [nextEmoji, setEmoji] = useState(emoji);
  const [nextName, setName] = useState(name);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);
  return (
    <form
      className="ds-checklist__head ds-checklist__head--editing"
      aria-label={`Rename ${name}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ emoji: nextEmoji.trim() === "" ? emoji : nextEmoji.trim(), name: nextName.trim() === "" ? name : nextName.trim() });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <input className="ds-text-input ds-checklist__emoji-input" aria-label="List emoji" value={nextEmoji} onChange={(e) => setEmoji(e.target.value)} />
      <input ref={nameRef} className="ds-text-input ds-checklist__name-input" aria-label="List name" value={nextName} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" variant="primary">
        Save
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** A yes/no question in place, for deleting something for everyone. */
export function Confirm({ question, confirmLabel, onConfirm, onCancel }: { question: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div
      className="ds-confirm"
      role="alertdialog"
      aria-label={question}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <p className="ds-confirm__question">{question}</p>
      <div className="ds-confirm__actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/** One item: tick it, tap its words to rename it, or delete it (asks first). */
export function CheckRow({
  text,
  checked,
  onToggle,
  onRename,
  onRemove,
}: {
  text: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
  /** Resolves to a message to show when the new name is refused, or null when it was saved. */
  onRename: (next: string) => Promise<string | null>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** While a rename is saving the field is read-only, so nothing typed in the meantime can be lost. */
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const stop = () => {
    setEditing(false);
    setError(null);
    setDraft(text);
  };
  const commit = async () => {
    if (saving) return;
    const next = draft.trim();
    if (next === "" || next === text) return stop();
    setSaving(true);
    const refused = await onRename(next);
    setSaving(false);
    if (refused !== null) return setError(refused);
    setEditing(false);
    setError(null);
  };

  return (
    <div className={checked ? "ds-check-row ds-check-row--done" : "ds-check-row"} role="listitem">
      <button type="button" className="ds-check-row__box" role="checkbox" aria-checked={checked} aria-label={checked ? `Untick ${text}` : `Tick ${text}`} onClick={() => onToggle(!checked)}>
        <span className="ds-check-row__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.2 4.3L19 7" />
          </svg>
        </span>
      </button>
      {editing ? (
        <div className="ds-check-row__edit">
          <input
            ref={inputRef}
            className="ds-check-row__input"
            aria-label={`Rename ${text}`}
            aria-invalid={error === null ? undefined : true}
            aria-busy={saving}
            readOnly={saving}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") stop();
            }}
          />
          {error === null ? null : (
            <p className="ds-check-row__error" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="ds-check-row__text"
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
        >
          {text}
        </button>
      )}
      {confirming ? (
        <Confirm
          question="Delete this item?"
          confirmLabel="Delete"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onRemove();
          }}
        />
      ) : (
        <button type="button" className="ds-check-row__delete" aria-label={`Delete ${text}`} onClick={() => setConfirming(true)}>
          <CloseIcon size={16} />
        </button>
      )}
    </div>
  );
}

/** "Add an item…": Enter adds it. Resolves to a message to show when it is refused, or null when it was added. */
export function AddItemField({ label, onAdd }: { label: string; onAdd: (text: string) => Promise<string | null> }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="ds-add-item"
      onSubmit={(e) => {
        e.preventDefault();
        const text = draft.trim();
        if (text === "") return;
        void (async () => {
          const refused = await onAdd(text);
          // Only clear what was sent: anything typed while it was saving stays.
          if (refused === null) setDraft((current) => (current.trim() === text ? "" : current));
          setError(refused);
        })();
      }}
    >
      <input
        className="ds-add-item__input"
        aria-label={label}
        aria-invalid={error === null ? undefined : true}
        placeholder="Add an item…"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
      />
      {error === null ? null : (
        <p className="ds-check-row__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export type MenuEntry = { key: string; label: string; onSelect: () => void };

/** A small menu behind one button. Closes on a choice, a tap outside, or Escape. */
export function Menu({ label, entries }: { label: string; entries: readonly MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target) !== true) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="ds-menu" ref={ref}>
      <button type="button" className="ds-menu__button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className="ds-menu__list" role="menu" aria-label={label}>
          {entries.map((e) => (
            <button
              key={e.key}
              type="button"
              role="menuitem"
              className="ds-menu__item"
              onClick={() => {
                setOpen(false);
                e.onSelect();
              }}
            >
              {e.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
