import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** The page shell: ground colour, page padding, one column on a phone (HOME-10). */
export function Page({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <main className="ds-page" aria-label={label}>
      {children}
    </main>
  );
}

export function PageBody({ children }: { children: ReactNode }) {
  return <div className="ds-page__body">{children}</div>;
}

/** Two generic slots: main (two thirds) and aside (one third). Collapses to one column on narrow screens. */
export function Columns({ main, aside }: { main: ReactNode; aside: ReactNode }) {
  const hasAside = aside !== null && aside !== undefined && aside !== false;
  return (
    <div className="ds-columns">
      <div className={hasAside ? "ds-columns__main" : "ds-columns__main ds-columns__main--full"}>{main}</div>
      {hasAside ? <div className="ds-columns__aside">{aside}</div> : null}
    </div>
  );
}

/** A centred single column for a focused composition (slow day). */
export function Focus({ children }: { children: ReactNode }) {
  return <div className="ds-focus">{children}</div>;
}

export function Footer({ children }: { children: ReactNode }) {
  return <footer className="ds-footer">{children}</footer>;
}

export function Stack({ children, tight = false }: { children: ReactNode; tight?: boolean }) {
  return <div className={tight ? "ds-stack ds-stack--tight" : "ds-stack"}>{children}</div>;
}

export function Row({ children, between = false }: { children: ReactNode; between?: boolean }) {
  return <div className={between ? "ds-row ds-row--between" : "ds-row"}>{children}</div>;
}

export function Grid3({ children }: { children: ReactNode }) {
  return <div className="ds-grid3">{children}</div>;
}

export type NavLink = { to: string; label: string };

/** Title, the one context line, and the secondary nav — links only, no tab bar, no badges (HOME-9). */
export function Header({ title, line, nav }: { title: string; line?: string; nav: readonly NavLink[] }) {
  return (
    <header className="ds-header">
      <div className="ds-header__text">
        <h1 className="ds-header__title">{title}</h1>
        {line === undefined || line === "" ? null : <p className="ds-header__line">{line}</p>}
      </div>
      <nav className="ds-nav" aria-label="Secondary">
        {nav.map((n) => (
          <Link key={n.to} to={n.to}>
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function Section({ label, tone = "muted", children }: { label: string; tone?: "muted" | "suggestion"; children: ReactNode }) {
  return (
    <section className="ds-section" aria-label={label === "" ? undefined : label}>
      {label === "" ? null : <h2 className={tone === "suggestion" ? "ds-section__label ds-section__label--suggestion" : "ds-section__label"}>{label}</h2>}
      <div className="ds-section__body">{children}</div>
    </section>
  );
}
