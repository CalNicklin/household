import type { LocalDate } from "@household/contracts";
import { z } from "zod";
import type { HourlyForecast, WeatherSource } from "../ports.ts";
import { defaultFetch, expectOk, type Fetch } from "./http.ts";

const zForecast = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    precipitation_probability: z.array(z.number().nullable()),
    temperature_2m: z.array(z.number().nullable()),
  }),
});

/** Open-Meteo needs no key. Hours come back in the house's local time because we ask for its zone. */
export class OpenMeteoWeather implements WeatherSource {
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  constructor(options: { baseUrl?: string; fetch?: Fetch } = {}) {
    this.#baseUrl = options.baseUrl ?? "https://api.open-meteo.com";
    this.#fetch = options.fetch ?? defaultFetch;
  }

  async hourly(date: LocalDate, latitude: number, longitude: number, timeZone: string): Promise<HourlyForecast[]> {
    const url = new URL("/v1/forecast", this.#baseUrl);
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("hourly", "precipitation_probability,temperature_2m");
    url.searchParams.set("timezone", timeZone);
    url.searchParams.set("start_date", date);
    url.searchParams.set("end_date", date);
    const response = await expectOk(await this.#fetch(url.toString()), "Open-Meteo forecast");
    const body = zForecast.parse(await response.json());
    return body.hourly.time.map((time, i) => ({
      hour: `${time.slice(0, 13)}:00`,
      precipitationProbability: body.hourly.precipitation_probability[i] ?? 0,
      temperatureC: body.hourly.temperature_2m[i] ?? 0,
    }));
  }
}
