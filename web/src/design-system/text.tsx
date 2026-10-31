import type { ReactNode } from "react";

type Tone = "default" | "muted" | "suggestion" | "alert";

const TONES: Record<Tone, string> = { default: "", muted: " ds-text--muted", suggestion: " ds-text--suggestion", alert: " ds-text--alert" };

export function Text({ children, tone = "default", small = false, mono = false }: { children: ReactNode; tone?: Tone; small?: boolean; mono?: boolean }) {
  return <p className={`ds-text${TONES[tone]}${small ? " ds-text--small" : ""}${mono ? " ds-text--mono" : ""}`}>{children}</p>;
}

export function Table({ head, rows, label }: { head: readonly string[]; rows: readonly (readonly ReactNode[])[]; label: string }) {
  return (
    <div className="ds-scroll-x">
      <table className="ds-table" aria-label={label}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- rows have no identity of their own
            <tr key={i}>
              {r.map((cell, j) => (
                // oxlint-disable-next-line react/no-array-index-key -- cells are positional
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Image({ src, alt }: { src: string; alt: string }) {
  return <img className="ds-image" src={src} alt={alt} loading="lazy" />;
}

/** A quiet line at the bottom of a page (e.g. "5 more, parked"). */
export function Footnote({ children }: { children: ReactNode }) {
  return <div className="ds-footnote">{children}</div>;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
