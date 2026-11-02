/**
 * QA-9: the practice household. Made-up people, calendar, parcels and supermarket account.
 * Automations are proven here before they touch the real house.
 */
import { BacklogTag, Channel, NurseryEventKind, PersonRole, Practice, Weekday } from "@household/contracts";

export const PRACTICE_HOUSEHOLD = "practice";
export const PRACTICE_TZ = "Europe/London";
/** Monday 2 November 2026, 07:00 in London (GMT). The practice clock starts here. */
export const PRACTICE_START = "2026-11-02T07:00:00.000Z";
export const PRACTICE_PASSWORD = Practice.login;
/** The practice household's app logins (all with PRACTICE_PASSWORD). Public on purpose: nothing behind them is real. */
export const logins = [
  { personId: "priya", username: "priya" },
  { personId: "tom", username: "tom" },
] as const;

export const people = [
  { id: "priya", name: "Priya", role: PersonRole.adult, nurseryDays: [] },
  { id: "tom", name: "Tom", role: PersonRole.adult, nurseryDays: [] },
  { id: "ivy", name: "Ivy", role: PersonRole.child, nurseryDays: [Weekday.mon, Weekday.tue, Weekday.thu] },
  { id: "noah", name: "Noah", role: PersonRole.child, nurseryDays: [Weekday.mon, Weekday.wed, Weekday.thu] },
] as const;

export const identities = [
  { personId: "priya", channel: Channel.telegram, address: "1001" },
  { personId: "tom", channel: Channel.telegram, address: "1002" },
  { personId: "priya", channel: Channel.email, address: "priya@practice.home" },
  { personId: "tom", channel: Channel.email, address: "tom@practice.home" },
  { personId: "priya", channel: Channel.app, address: "priya" },
  { personId: "tom", channel: Channel.app, address: "tom" },
  { personId: "priya", channel: Channel.mcp, address: "priya" },
  { personId: "tom", channel: Channel.mcp, address: "tom" },
] as const;

export const sitters = [
  { name: "Jess", knownFreeDays: [Weekday.tue, Weekday.fri], telegram: "2001" },
  { name: "Marta", knownFreeDays: [], telegram: "2002" },
] as const;

export const rules = [
  { createdBy: "tom", spec: { kind: "bins", collectionDay: Weekday.tue, evenWeeks: ["general waste", "food"], oddWeeks: ["recycling", "food"] } },
  { createdBy: "priya", spec: { kind: "chore", title: "Water the plants", everyDays: 4, anchorDate: "2026-10-31" } },
  { createdBy: "priya", spec: { kind: "chore", title: "Change the beds", everyDays: 7, anchorDate: "2026-10-27" } },
] as const;

export const nurseryTerms = [
  { start: "2026-09-03", end: "2026-12-18" },
  { start: "2027-01-05", end: "2027-03-26" },
] as const;

export const nurseryEvents = [
  { kind: NurseryEventKind.party, date: "2026-11-05", title: "Bonfire party at nursery, 3pm", coveredBy: "priya" },
  { kind: NurseryEventKind.inset, date: "2026-11-06", title: "Nursery inset day", coveredBy: null },
  { kind: NurseryEventKind.closure, date: "2026-11-20", title: "Nursery closed (staff training)", coveredBy: "tom" },
] as const;

export const wellbeingIdeas = [
  { text: "A walk on your own", createdBy: "priya" },
  { text: "An early night", createdBy: "priya" },
  { text: "Cancel one thing", createdBy: "tom" },
  { text: "Get a takeaway", createdBy: "tom" },
  { text: "Call a friend", createdBy: "priya" },
] as const;

/**
 * HOME-1: the practice household's Google calendars, each with its owner, as GOOGLE_CALENDARS names
 * the real ones: Priya's and Tom's own, and the shared one.
 */
export const calendars = [
  { calendarId: "priya@practice.home", owner: "priya" },
  { calendarId: "tom@practice.home", owner: "tom" },
  { calendarId: "family@practice.home", owner: "shared" },
] as const;

export type PracticeEvent = {
  /** Google's event ID; an invite has the same one on every calendar it is on. */
  externalId: string;
  /** Whose calendar this copy is on (default: the shared one). */
  calendar?: string | undefined;
  /** Google's iCalUID: copies on several calendars share it and are one event. */
  uid?: string | undefined;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  attendees: string[];
  away?: string[];
  work?: boolean;
  soloWithKids?: string | null;
};

/**
 * A week of the practice calendars, as Google would return them: each person's own events on their
 * own calendar, the kids' on the shared one, and one invite (dinner at Sam's) on both Priya's and
 * Tom's, which the house reads as one event with both of them out.
 */
export const calendar: PracticeEvent[] = [
  { externalId: "g-mon-drop", calendar: "priya", title: "Nursery drop-off", start: "2026-11-02T08:45:00Z", end: "2026-11-02T09:00:00Z", attendees: ["priya"] },
  { externalId: "g-mon-call", calendar: "priya", title: "Priya — client call", start: "2026-11-02T13:00:00Z", end: "2026-11-02T13:45:00Z", attendees: ["priya"], work: true, soloWithKids: "tom" },
  { externalId: "g-mon-pick", calendar: "tom", title: "Nursery pick-up", start: "2026-11-02T16:10:00Z", end: "2026-11-02T16:30:00Z", attendees: ["tom"] },
  { externalId: "g-tue-dinner", calendar: "priya", uid: "dinner-at-sams@practice.home", title: "Dinner at Sam's", start: "2026-11-03T19:30:00Z", end: "2026-11-03T23:00:00Z", attendees: ["priya"], away: ["priya"] },
  { externalId: "g-tue-dinner", calendar: "tom", uid: "dinner-at-sams@practice.home", title: "Dinner at Sam's", start: "2026-11-03T19:30:00Z", end: "2026-11-03T23:00:00Z", attendees: ["tom"], away: ["tom"] },
  { externalId: "g-wed-leeds", calendar: "tom", title: "Tom — Leeds site visit", start: "2026-11-04T06:30:00Z", end: "2026-11-04T18:00:00Z", attendees: ["tom"], away: ["tom"], work: true, soloWithKids: "priya" },
  { externalId: "g-thu-office", calendar: "priya", title: "Priya — office day", start: "2026-11-05T09:00:00Z", end: "2026-11-05T17:00:00Z", attendees: ["priya"], away: ["priya"], work: true },
  { externalId: "g-thu-football", calendar: "tom", title: "Tom — five-a-side", start: "2026-11-05T19:00:00Z", end: "2026-11-05T21:00:00Z", attendees: ["tom"], away: ["tom"], soloWithKids: "priya" },
  { externalId: "g-fri-early", calendar: "priya", title: "Priya — early train", start: "2026-11-06T06:15:00Z", end: "2026-11-06T12:00:00Z", attendees: ["priya"], away: ["priya"], work: true, soloWithKids: "tom" },
  { externalId: "g-sat-grandma", title: "Kids at Grandma's", start: "2026-11-07T09:30:00Z", end: "2026-11-07T13:00:00Z", attendees: ["ivy", "noah"] },
  { externalId: "g-thu-theatre", title: "Theatre — both", start: "2026-11-12T19:00:00Z", end: "2026-11-12T22:30:00Z", attendees: ["priya", "tom"], away: ["priya", "tom"] },
];

/** Hourly chance of rain (0–100) per date, 06:00 to 21:00 local. Anything not listed is 20%. */
export const weather: Record<string, { dryUntil?: number; dryFrom?: number; wet?: boolean; tempC: number }> = {
  "2026-11-02": { dryUntil: 14, tempC: 9 },
  "2026-11-03": { wet: true, tempC: 8 },
  "2026-11-04": { tempC: 11 },
  "2026-11-05": { dryFrom: 15, tempC: 10 },
  "2026-11-06": { dryUntil: 12, tempC: 9 },
  "2026-11-07": { tempC: 12 },
  "2026-11-08": { wet: true, tempC: 7 },
};

export const backlog: { text: string; tags: BacklogTag[]; createdBy: string; daysAgo: number }[] = [
  { text: "Service the bike", tags: [BacklogTag.short, BacklogTag.dry, BacklogTag.noKids], createdBy: "tom", daysAgo: 21 },
  { text: "Put up the hallway pictures", tags: [BacklogTag.quick, BacklogTag.noKids], createdBy: "priya", daysAgo: 30 },
  { text: "Return the Screwfix order", tags: [BacklogTag.quick, BacklogTag.tripOut], createdBy: "tom", daysAgo: 4 },
  { text: "Clear the gutters", tags: [BacklogTag.short, BacklogTag.dry, BacklogTag.bothHome, BacklogTag.daylight], createdBy: "tom", daysAgo: 40 },
  { text: "Sort the loft boxes", tags: [BacklogTag.halfDay, BacklogTag.noKids], createdBy: "priya", daysAgo: 60 },
  { text: "Book the car in for MOT", tags: [BacklogTag.quick, BacklogTag.phoneCall, BacklogTag.officeHours], createdBy: "tom", daysAgo: 12 },
  { text: "Fix the garden gate latch", tags: [BacklogTag.short, BacklogTag.daylight], createdBy: "tom", daysAgo: 15 },
  { text: "Descale the coffee machine", tags: [BacklogTag.quick], createdBy: "priya", daysAgo: 0 },
  { text: "Find a plumber for the bathroom tap", tags: [BacklogTag.phoneCall, BacklogTag.officeHours], createdBy: "tom", daysAgo: 1 },
  { text: "Ring the nursery about Friday", tags: [BacklogTag.quick, BacklogTag.phoneCall, BacklogTag.officeHours], createdBy: "priya", daysAgo: 2 },
  { text: "Order Ivy's winter boots", tags: [BacklogTag.quick], createdBy: "priya", daysAgo: 5 },
  { text: "Rake the leaves", tags: [BacklogTag.short, BacklogTag.dry, BacklogTag.daylight], createdBy: "tom", daysAgo: 9 },
  { text: "Back up the family photos", tags: [BacklogTag.short], createdBy: "tom", daysAgo: 50 },
  { text: "Take old clothes to the charity shop", tags: [BacklogTag.quick, BacklogTag.tripOut], createdBy: "priya", daysAgo: 18 },
  { text: "Renew the passport for Noah", tags: [BacklogTag.short, BacklogTag.tripOut], createdBy: "priya", daysAgo: 25 },
  { text: "Paint the shed door", tags: [BacklogTag.halfDay, BacklogTag.dry, BacklogTag.daylight], createdBy: "tom", daysAgo: 70 },
  { text: "Clean the oven", tags: [BacklogTag.short, BacklogTag.noKids], createdBy: "priya", daysAgo: 33 },
  { text: "Call the council about the streetlight", tags: [BacklogTag.quick, BacklogTag.phoneCall, BacklogTag.officeHours], createdBy: "tom", daysAgo: 7 },
  { text: "Bleed the radiators", tags: [BacklogTag.short], createdBy: "tom", daysAgo: 14 },
  { text: "Write thank-you cards", tags: [BacklogTag.quick, BacklogTag.noKids], createdBy: "priya", daysAgo: 3 },
];

/** CAP-6: the shared lists, as Family Lists held them (one ticked item, to show it stays struck through). */
export const lists = [
  {
    name: "Shopping",
    emoji: "🛒",
    items: [
      { text: "washing-up liquid", checked: false, createdBy: "priya" },
      { text: "bin bags", checked: false, createdBy: "tom" },
      { text: "kitchen roll", checked: true, createdBy: "priya" },
    ],
  },
  {
    name: "Christmas presents",
    emoji: "🎁",
    items: [
      { text: "Lego for Noah", checked: false, createdBy: "priya" },
      { text: "Book for Ivy", checked: false, createdBy: "tom" },
    ],
  },
] as const;

export const parcels = [
  { shop: "Screwfix", expectedDate: "2026-11-02", window: "by 6pm", needsSomeoneIn: false },
  { shop: "Ocado", expectedDate: "2026-11-03", window: "7–8pm", needsSomeoneIn: true },
  { shop: "John Lewis", expectedDate: "2026-11-05", window: "8am–1pm", needsSomeoneIn: true },
] as const;

/** The practice supermarket's catalogue and the basket the practice account starts with. */
export const supermarket = {
  deliveryDate: "2026-11-03",
  catalogue: [
    { sku: "oat-1l", name: "Oatly Oat Drink Barista 1L", price: "£2.20", aliases: ["oat milk", "oat drink"] },
    { sku: "oat-semi-1l", name: "Oatly Oat Drink Semi 1L", price: "£1.95", aliases: [] },
    { sku: "bread-wm", name: "Hovis Wholemeal Medium 800g", price: "£1.60", aliases: ["bread", "wholemeal bread"] },
    { sku: "eggs-6", name: "Free Range Eggs x6", price: "£2.10", aliases: ["eggs"] },
    { sku: "eggs-12", name: "Free Range Eggs x12", price: "£3.80", aliases: [] },
    { sku: "bananas", name: "Bananas x5", price: "£0.95", aliases: ["bananas"] },
    { sku: "nappies-4", name: "Pampers Baby-Dry Size 4 x44", price: "£11.00", aliases: ["nappies size 4"] },
    { sku: "nappies-5", name: "Pampers Baby-Dry Size 5 x40", price: "£11.00", aliases: ["nappies size 5"] },
    { sku: "cheddar", name: "Mature Cheddar 400g", price: "£3.50", aliases: ["cheddar", "cheese"] },
    { sku: "apples", name: "Pink Lady Apples x4", price: "£2.30", aliases: ["apples"] },
    { sku: "pasta", name: "Fusilli Pasta 500g", price: "£0.85", aliases: ["pasta"] },
    { sku: "coffee", name: "Ground Coffee 227g", price: "£3.75", aliases: ["coffee"] },
  ],
  basket: [
    { sku: "bananas", quantity: 1 },
    { sku: "pasta", quantity: 2 },
  ],
} as const;
