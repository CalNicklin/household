/**
 * The household design system. Screens are built only from these components (usage.test.ts);
 * every value comes from design/tokens.json via tokens.css.
 */
import tokens from "../../../design/tokens.json";
import stylesheet from "./ds.css?url";

export const stylesheetHref: string = stylesheet;
/** The browser chrome and splash colour (HOME-6), from the shared token set. */
export const themeColour: string = tokens.color.ground;
export const fontsHref = "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap";

export { AlertCard, ArrivalRow, BacklogPickCard, BacklogRow, Card, type CardAction, EventCard, EventRow, ListCard, ModeCard, SuggestionCard } from "./cards.tsx";
export { AddItemField, ChecklistCard, ChecklistTitle, ChecklistTitleEditor, CheckRow, Confirm, Menu } from "./checklist.tsx";
export { Answer, Composer } from "./composer.tsx";
export { Button, Chip, Chips, Field, Form, Segmented, Stepper, TextInput, Toggle } from "./controls.tsx";
export { Columns, Focus, Footer, Grid3, Header, type NavLink, Page, PageBody, Row, Section, Stack } from "./layout.tsx";
export { ExternalLink, Footnote, Image, Table, Text } from "./text.tsx";
