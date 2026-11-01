/**
 * Everything outside the house. Each port has a real adapter and a practice-household fake (QA-9);
 * nothing else in the server talks to the outside world.
 */
import type { CalendarEvent, LocalDate, ProductOption } from "@household/contracts";

export interface Clock {
  now(): Date;
}

export type ExternalEvent = Omit<CalendarEvent, "id">;

/** Read-only by construction: there is no method that writes to the calendar (PRV-1). */
export interface CalendarSource {
  changes(syncToken: string | null): Promise<{ upserts: ExternalEvent[]; deletedExternalIds: string[]; nextSyncToken: string | null }>;
}

export type HourlyForecast = { hour: string; precipitationProbability: number; temperatureC: number };

export interface WeatherSource {
  hourly(date: LocalDate, latitude: number, longitude: number, timeZone: string): Promise<HourlyForecast[]>;
}

export type OutboundButton = { label: string; data: string };

/** WhatsApp/Telegram. Send-only; inbound arrives through the adapter's webhook. */
export interface MessengerTransport {
  send(address: string, text: string, buttons: OutboundButton[]): Promise<{ externalId: string }>;
}

/** CAP-6: the shared lists app stays the source of truth; we read and append, never copy. */
export interface ListsApp {
  lists(): Promise<{ name: string; items: string[] }[]>;
  add(list: string, item: string): Promise<void>;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export type MemoryScope = { household: string; person: string };

/** PLT-6: episodic memory (phrasing, dismissals) in Hindsight, always scoped to one person and house. */
export interface EpisodicMemory {
  retain(scope: MemoryScope, content: string): Promise<void>;
  recall(scope: MemoryScope, query: string): Promise<string[]>;
  forget(scope: MemoryScope): Promise<void>;
}

/** The sealed shopping helper (AUT-2). It runs elsewhere with its own supermarket login. */
export type HelperResult =
  | { kind: "added"; product: ProductOption; log: string[]; screenshots: { name: string; png: Uint8Array }[] }
  | { kind: "needs-choice"; options: ProductOption[]; log: string[]; screenshots: { name: string; png: Uint8Array }[] }
  | { kind: "failed"; reason: string; log: string[]; screenshots: { name: string; png: Uint8Array }[] };

export interface ShoppingHelper {
  addItem(item: string): Promise<HelperResult>;
  addProduct(sku: string): Promise<HelperResult>;
  basket(): Promise<{ items: { sku: string; name: string; quantity: number }[]; deliveryDate: LocalDate | null; changeUrl: string }>;
}

export interface Transcriber {
  transcribe(audio: Uint8Array, contentType: string): Promise<string>;
}

export type Ports = {
  clock: Clock;
  calendar: CalendarSource;
  weather: WeatherSource;
  messenger: MessengerTransport;
  lists: ListsApp;
  objects: ObjectStore;
  memory: EpisodicMemory;
  shopping: ShoppingHelper;
  transcriber: Transcriber;
};
