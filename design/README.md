# Design

`canvas/` holds the screens as exported from the design canvas: one self-contained HTML file per artboard, plus `canvas.json` with their layout. The markup is plain HTML with inline styles; the `<x-dc>` wrapper, `<helmet>` and the trailing `<script type="text/x-dc">` block are the canvas's own format and can be ignored when reading the design. Each file renders in a browser if you remove the `<script src="./support.js">` line.

| File | What it is |
| --- | --- |
| `Main.dc.html` | Home screen, iPad landscape (1180×820), an ordinary Monday |
| `SlowDay.dc.html` | Same screen composed for a slow day: one `mode` block |
| `Phone.dc.html` | Home screen at phone width (390×844) |
| `Backlog.dc.html` | Backlog: dump box, Could go soon / Waiting / Just added, parked |
| `Components.dc.html` | The block vocabulary the planner composes from |

## Tokens used throughout

- Ground `#F3F4F6`, surface `#FFFFFF`, text `#17191C`, muted `#5B6168`, hairline `#EDEEF1`, border `#E2E4E8`
- Suggestion (planner-made): bg `#E3F0EB`, accent `#1F6B5A`, text `#2C5648`
- Alert (rule-derived): bg `#FBF1DC`, accent `#8A5A00`, text `#6B4A08`
- Type: Manrope 400/500/600/700; section labels 13px uppercase 1.2px tracking; titles 34px/26px; body 17px/15px
- Radius 16px cards, 12px buttons; all tap targets ≥ 44px

Colour means provenance: green is something the planner suggested, amber is something a rule derived, grey is a fact from the calendar or email. Every planner-made block has a no-guilt dismiss.

These are the reference until the Paper frames exist (QA-3); once they do, Paper is the source and this folder is history.
