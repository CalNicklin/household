import type { LocalDate, ProductOption } from "@household/contracts";
import type {
  CalendarSource,
  Clock,
  EpisodicMemory,
  ExternalEvent,
  HelperResult,
  HourlyForecast,
  ListsApp,
  MemoryScope,
  MessengerTransport,
  ObjectStore,
  OutboundButton,
  Ports,
  ShoppingHelper,
  Transcriber,
  WeatherSource,
} from "../server/ports.ts";
import { calendar, PRACTICE_START, supermarket, weather } from "./data.ts";

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

/** A Google Calendar stand-in: edits bump a version, `changes` returns what changed since a token. */
export class PracticeCalendar implements CalendarSource {
  #events = new Map<string, { event: ExternalEvent; version: number; deleted: boolean }>();
  #version = 0;
  constructor() {
    this.reset();
  }
  reset(): void {
    this.#events.clear();
    this.#version = 0;
    for (const e of calendar) this.upsert({ externalId: e.externalId, title: e.title, start: e.start, end: e.end, attendees: e.attendees, soloWithKids: e.soloWithKids ?? null, away: e.away ?? [], work: e.work ?? false, allDay: e.allDay ?? false });
  }
  upsert(event: ExternalEvent): void {
    this.#version += 1;
    this.#events.set(event.externalId, { event, version: this.#version, deleted: false });
  }
  remove(externalId: string): void {
    const existing = this.#events.get(externalId);
    if (existing === undefined) return;
    this.#version += 1;
    this.#events.set(externalId, { ...existing, version: this.#version, deleted: true });
  }
  list(): ExternalEvent[] {
    return [...this.#events.values()].filter((e) => !e.deleted).map((e) => e.event);
  }
  async changes(syncToken: string | null) {
    const since = syncToken === null ? 0 : Number(syncToken);
    const changed = [...this.#events.values()].filter((e) => e.version > since);
    return {
      upserts: changed.filter((e) => !e.deleted).map((e) => e.event),
      deletedExternalIds: changed.filter((e) => e.deleted).map((e) => e.event.externalId),
      nextSyncToken: String(this.#version),
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

export class PracticeLists implements ListsApp {
  readonly #lists = new Map<string, string[]>();
  constructor() {
    this.reset();
  }
  reset(): void {
    this.#lists.clear();
    this.#lists.set("Shopping", ["washing-up liquid", "bin bags"]);
    this.#lists.set("Christmas presents", ["Lego for Noah", "Book for Ivy"]);
  }
  async lists() {
    return [...this.#lists.entries()].map(([name, items]) => ({ name, items: [...items] }));
  }
  async add(list: string, item: string) {
    const items = this.#lists.get(list) ?? [];
    if (!items.includes(item)) items.push(item);
    this.#lists.set(list, items);
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
  lists: PracticeLists;
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
    lists: new PracticeLists(),
    objects: new MemoryObjectStore(),
    memory: new InMemoryEpisodicMemory(),
    shopping: options.shopping ?? new PracticeShoppingHelper(),
    transcriber: new PracticeTranscriber(),
  };
}
