import { readFile } from "node:fs/promises";
import type { TranscriptionModel } from "ai";
import { z } from "zod";
import {
  InMemoryEpisodicMemory,
  MemoryObjectStore,
  PracticeCalendar,
  PracticeMessenger,
  PracticeShoppingHelper,
  PracticeTranscriber,
} from "../../practice/fakes.ts";
import type { Env } from "../env.ts";
import type { CalendarPush, CalendarSource, Clock, ObjectStore, Ports, ShoppingHelper } from "../ports.ts";
import { GoogleCalendarPush, GoogleCalendarSource, refreshingTokenProvider } from "./google-calendar.ts";
import { HindsightMemory } from "./hindsight-memory.ts";
import { NoShoppingHelper } from "./shopping-helper.ts";
import { FsObjectStore, S3ObjectStore } from "./s3-object-store.ts";
import { TelegramTransport } from "./telegram.ts";
import { AiSdkTranscriber } from "./transcriber.ts";
import { OpenMeteoWeather } from "./weather-open-meteo.ts";

/**
 * The Google credentials file named by GOOGLE_ACCESS_TOKEN_FILE lives in the vault (a docker
 * secret), never in env or a prompt. It holds either a refresh-token grant or a fixed access token.
 */
const zGoogleCredentials = z.union([
  z.object({ client_id: z.string(), client_secret: z.string(), refresh_token: z.string(), token_url: z.string().optional() }),
  z.object({ access_token: z.string() }),
]);

export function googleTokenFromFile(file: string, clock: Clock): () => Promise<string> {
  let provider: (() => Promise<string>) | null = null;
  const fromFile = async (): Promise<string> => {
    if (provider === null) {
      const creds = zGoogleCredentials.parse(JSON.parse(await readFile(file, "utf8")));
      if ("access_token" in creds) {
        const token = creds.access_token;
        provider = async () => token;
      } else {
        provider = refreshingTokenProvider({
          clientId: creds.client_id,
          clientSecret: creds.client_secret,
          refreshToken: creds.refresh_token,
          clock,
          ...(creds.token_url === undefined ? {} : { tokenUrl: creds.token_url }),
        });
      }
    }
    return provider();
  };
  return async () => {
    try {
      return await fromFile();
    } catch (error) {
      // Read the file again next time: after a refused refresh token Cal copies in a new google.json,
      // and the house picks it up without a restart (docs/OPERATIONS.md, "Google Calendar").
      provider = null;
      throw error;
    }
  };
}

export type RealPortsOptions = {
  timeZone: string;
  /** CH-3: an attendee's email to a household person (from the household identities). */
  personForEmail: (email: string) => string | null;
  /** The sealed shopping helper's client, when it is running (AUT-2). */
  shopping?: ShoppingHelper;
  /** Speech-to-text model from the configured provider (PLT-9). */
  transcriptionModel?: TranscriptionModel;
  workCalendarIds?: readonly string[];
};

/**
 * The real house runs without the helper until it has a home machine (Waitrose blocks data-centre
 * addresses): each shopping request is recorded and fails at once with that reason ("nothing was added"),
 * never added to a practice basket; nothing retries it.
 */
function shoppingPort(env: Env, helper: ShoppingHelper | undefined, missing: string[]): ShoppingHelper {
  if (helper !== undefined) return helper;
  if (env.PRACTICE) {
    missing.push("shopping");
    return new PracticeShoppingHelper();
  }
  missing.push("shopping (no helper: nothing is added)");
  return new NoShoppingHelper();
}

/**
 * Ports for the real house. Anything not configured falls back to the practice fake and is named
 * in `missing`, so start-up can say exactly what still needs a human to provide.
 */
export function realPorts(env: Env, clock: Clock, options: RealPortsOptions): { ports: Ports; missing: string[] } {
  const missing: string[] = [];

  let calendar: CalendarSource;
  let calendarPush: CalendarPush | undefined;
  if (env.GOOGLE_CALENDAR_ID !== undefined && env.GOOGLE_ACCESS_TOKEN_FILE !== undefined) {
    const getAccessToken = googleTokenFromFile(env.GOOGLE_ACCESS_TOKEN_FILE, clock);
    calendar = new GoogleCalendarSource({
      calendarId: env.GOOGLE_CALENDAR_ID,
      getAccessToken,
      personForEmail: options.personForEmail,
      timeZone: options.timeZone,
      clock,
      baseUrl: env.GOOGLE_CALENDAR_API,
      ...(options.workCalendarIds === undefined ? {} : { workCalendarIds: options.workCalendarIds }),
    });
    calendarPush = new GoogleCalendarPush({ calendarId: env.GOOGLE_CALENDAR_ID, getAccessToken, baseUrl: env.GOOGLE_CALENDAR_API });
  } else {
    missing.push("calendar");
    calendar = new PracticeCalendar();
  }

  let messenger: Ports["messenger"];
  if (env.TELEGRAM_BOT_TOKEN === undefined) {
    missing.push("messenger");
    messenger = new PracticeMessenger(clock);
  } else {
    messenger = new TelegramTransport({ token: env.TELEGRAM_BOT_TOKEN, apiBase: env.TELEGRAM_API_BASE });
  }

  let objects: ObjectStore;
  if (env.S3_ENDPOINT !== undefined && env.S3_ACCESS_KEY_ID !== undefined && env.S3_SECRET_ACCESS_KEY !== undefined) {
    objects = new S3ObjectStore({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, encryptionKey: env.STORAGE_KEY });
  } else if (env.PRACTICE) {
    objects = new MemoryObjectStore();
    missing.push("objects");
  } else {
    objects = new FsObjectStore({ dir: env.OBJECT_DIR, encryptionKey: env.STORAGE_KEY });
    missing.push("objects (using encrypted local files)");
  }

  let memory: Ports["memory"];
  if (env.HINDSIGHT_URL === undefined) {
    missing.push("memory");
    memory = new InMemoryEpisodicMemory();
  } else {
    memory = new HindsightMemory({ baseUrl: env.HINDSIGHT_URL });
  }

  const shopping = shoppingPort(env, options.shopping, missing);

  let transcriber: Ports["transcriber"];
  if (options.transcriptionModel === undefined) {
    missing.push("transcriber");
    transcriber = new PracticeTranscriber();
  } else {
    transcriber = new AiSdkTranscriber(options.transcriptionModel);
  }

  return {
    ports: { clock, calendar, ...(calendarPush === undefined ? {} : { calendarPush }), weather: new OpenMeteoWeather(), messenger, objects, memory, shopping, transcriber },
    missing,
  };
}
