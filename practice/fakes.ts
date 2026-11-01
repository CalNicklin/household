import type { LocalDate, ProductOption } from "@household/contracts";
import type {
  CalendarChanges,
  CalendarSource,
  Clock,
  EpisodicMemory,
  ExternalEvent,
  HelperResult,
  HourlyForecast,
  MemoryScope,
  MessengerTransport,
  ObjectStore,
  OutboundButton,
  Ports,
  ShoppingHelper,
  Transcriber,
  WeatherSource,
} from "../server/ports.ts";
import { calendar, calendars, PRACTICE_START, type PracticeEvent, supermarket, weather } from "./data.ts";

/** Runs in real time from a settable starting point, or frozen for unit tests. */
export class PracticeClock implements Clock {
  #base: number;
  #setAt: number;
  #frozen: boolean;
  constructor(start: string = PRACTICE_START, frozen = false) {
    this.#base = new Date(start).getTime();
    this.#setAt = Date.now();
    this.#frozen = frozen;
  }
  now(): Date {
    return new Date(this.#frozen ? this.#base : this.#base + (Date.now() - this.#setAt));
  }
  set(at: string | Date, frozen = this.#frozen): void {
    this.#base = new Date(at).getTime();
    this.#setAt = Date.now();
    this.#frozen = frozen;
  }
}

/** One practice calendar's copy of an event, as the house stores it (practice/seed.ts writes the same). */
export function practiceCopy(e: PracticeEvent): ExternalEvent {
  const owner = e.calendar ?? "shared";
  const calendarId = calendars.find((c) => c.owner === owner)?.calendarId;
  if (calendarId === undefined) throw new Error(`no practice calendar for ${owner}`);
  return {
    externalId: `${calendarId}/${e.externalId}`,
    calendarId,
    owner,
    uid: e.uid ?? null,
    busy: false,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay ?? false,
    attendees: e.attendees,
    away: e.away ?? [],
    work: e.work ?? false,
    soloWithKids: e.soloWithKids ?? null,
  };
}

/**
 * Google Calendar stand-in for the practice household's calendars (Priya's, Tom's and the shared
 * one): edits bump a version, `changes` returns what changed on each calendar since its token.
 */
export class PracticeCalendar implements CalendarSource {
  readonly calendars = calendars;
  #events = new Map<string, { event: ExternalEvent; version: number; deleted: boolean }>();
  #version = 0;
  constructor() {
    this.reset();
  }
  /** HOU-149: no events at all, as a brand-new house's Google Calendar would look before anyone adds one. */
  clear(): void {
    this.#events.clear();
    this.#version = 0;
  }
  reset(): void {
    this.clear();
    for (const e of calendar) this.upsert(e);
  }
  /** Add or change one calendar's copy (the shared calendar's unless `calendar` names a person). */
  upsert(event: PracticeEvent): void {
    const copy = practiceCopy(event);
    this.#version += 1;
    this.#events.set(copy.externalId, { event: copy, version: this.#version, deleted: false });
  }
  /** Delete a Google event: its copy on every calendar. */
  remove(externalId: string): void {
    for (const [key, existing] of this.#events) {
      if (!key.endsWith(`/${externalId}`) || existing.deleted) continue;
      this.#version += 1;
      this.#events.set(key, { ...existing, version: this.#version, deleted: true });
    }
  }
  list(): ExternalEvent[] {
    return [...this.#events.values()].filter((e) => !e.deleted).map((e) => e.event);
  }
  async changes(syncTokens: Readonly<Record<string, string>>): Promise<CalendarChanges> {
    const changed = [...this.#events.values()].filter((e) => e.version > Number(syncTokens[e.event.calendarId] ?? 0));
    return {
      upserts: changed.filter((e) => !e.deleted).map((e) => e.event),
      deletedExternalIds: changed.filter((e) => e.deleted).map((e) => e.event.externalId),
      nextSyncTokens: Object.fromEntries(this.calendars.map((c) => [c.calendarId, String(this.#version)])),
      complete: true,
    };
  }
}

class PracticeWeather implements WeatherSource {
  readonly overrides = new Map<LocalDate, HourlyForecast[]>();
  async hourly(date: LocalDate): Promise<HourlyForecast[]> {
    const override = this.overrides.get(date);
    if (override !== undefined) return override;
    const day = weather[date] ?? { tempC: 10 };
    const out: HourlyForecast[] = [];
    for (let h = 6; h <= 21; h++) {
      const dry = day.wet === true ? false : (day.dryUntil === undefined || h < day.dryUntil) && (day.dryFrom === undefined || h >= day.dryFrom);
      out.push({ hour: `${date}T${String(h).padStart(2, "0")}:00`, precipitationProbability: dry ? 10 : 80, temperatureC: day.tempC });
    }
    return out;
  }
}

export type SentMessage = { address: string; text: string; buttons: OutboundButton[]; externalId: string; at: string };

/** Telegram stand-in. Every send is recorded so tests and the practice phone can see it. */
export class PracticeMessenger implements MessengerTransport {
  readonly sent: SentMessage[] = [];
  #n = 0;
  readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }
  async send(address: string, text: string, buttons: OutboundButton[]) {
    this.#n += 1;
    const externalId = `tg-${this.#n}`;
    this.sent.push({ address, text, buttons, externalId, at: this.clock.now().toISOString() });
    return { externalId };
  }
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/** Hindsight stand-in: per-person, per-house banks (PLT-6). */
export class InMemoryEpisodicMemory implements EpisodicMemory {
  readonly banks = new Map<string, string[]>();
  #bank(scope: MemoryScope) {
    return `${scope.household}:${scope.person}`;
  }
  async retain(scope: MemoryScope, content: string) {
    const bank = this.banks.get(this.#bank(scope)) ?? [];
    bank.push(content);
    this.banks.set(this.#bank(scope), bank);
  }
  async recall(scope: MemoryScope, query: string) {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const bank = this.banks.get(this.#bank(scope)) ?? [];
    return bank.filter((m) => words.some((w) => m.toLowerCase().includes(w))).slice(-5);
  }
  async forget(scope: MemoryScope) {
    this.banks.delete(this.#bank(scope));
  }
}

const toOption = (p: (typeof supermarket.catalogue)[number]): ProductOption => ({ sku: p.sku, name: p.name, price: p.price });

/** The practice supermarket's matching rules, used in-process by unit tests. */
export class PracticeShoppingHelper implements ShoppingHelper {
  readonly basketItems = new Map<string, number>(supermarket.basket.map((b) => [b.sku, b.quantity]));
  #find(item: string): { exact: ProductOption | null; options: ProductOption[] } {
    const q = item.toLowerCase().trim();
    const exact = supermarket.catalogue.find((p) => (p.aliases as readonly string[]).includes(q));
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    const options = supermarket.catalogue.filter((p) => words.some((w) => p.name.toLowerCase().includes(w)));
    return { exact: exact === undefined ? null : toOption(exact), options: options.map(toOption) };
  }
  async addItem(item: string): Promise<HelperResult> {
    const found = this.#find(item);
    if (found.exact !== null) return this.addProduct(found.exact.sku);
    if (found.options.length === 0) return { kind: "failed", reason: `nothing like "${item}"`, log: [`searched "${item}": no results`], screenshots: [] };
    return { kind: "needs-choice", options: found.options.slice(0, 3), log: [`searched "${item}": ${found.options.length} close matches, no exact one`], screenshots: [] };
  }
  async addProduct(sku: string): Promise<HelperResult> {
    const product = supermarket.catalogue.find((p) => p.sku === sku);
    if (product === undefined) return { kind: "failed", reason: `no product ${sku}`, log: [], screenshots: [] };
    this.basketItems.set(sku, (this.basketItems.get(sku) ?? 0) + 1);
    return { kind: "added", product: { sku: product.sku, name: product.name, price: product.price }, log: [`added ${product.name}`], screenshots: [] };
  }
  async basket() {
    return {
      items: [...this.basketItems.entries()].map(([sku, quantity]) => ({ sku, name: supermarket.catalogue.find((p) => p.sku === sku)?.name ?? sku, quantity })),
      deliveryDate: supermarket.deliveryDate,
      changeUrl: "http://localhost:3002/basket",
    };
  }
}

export class PracticeTranscriber implements Transcriber {
  async transcribe(): Promise<string> {
    return "";
  }
}

export type PracticePorts = Ports & {
  clock: PracticeClock;
  calendar: PracticeCalendar;
  weather: PracticeWeather;
  messenger: PracticeMessenger;
  objects: MemoryObjectStore;
  memory: InMemoryEpisodicMemory;
};

export function practicePorts(options: { start?: string; frozen?: boolean; shopping?: ShoppingHelper } = {}): PracticePorts {
  const clock = new PracticeClock(options.start ?? PRACTICE_START, options.frozen ?? false);
  return {
    clock,
    calendar: new PracticeCalendar(),
    weather: new PracticeWeather(),
    messenger: new PracticeMessenger(clock),
    objects: new MemoryObjectStore(),
    memory: new InMemoryEpisodicMemory(),
    shopping: options.shopping ?? new PracticeShoppingHelper(),
    transcriber: new PracticeTranscriber(),
  };
}
