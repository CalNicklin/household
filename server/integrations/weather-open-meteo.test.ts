import { afterEach, describe, expect, it } from "vitest";
import { fakeServer, json } from "./fake-http.ts";
import { OpenMeteoWeather } from "./weather-open-meteo.ts";

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("Open-Meteo weather", () => {
  it("[HOME-2][PRO-4] reads the hourly forecast for one local day in the house's time zone", async () => {
    const server = await fakeServer((_req, res) =>
      json(res, 200, { hourly: { time: ["2026-11-02T00:00", "2026-11-02T14:00"], precipitation_probability: [5, 70], temperature_2m: [7.5, null] } }),
    );
    servers.push(server);
    const weather = new OpenMeteoWeather({ baseUrl: server.url });
    const hours = await weather.hourly("2026-11-02", 51.45, -2.58, "Europe/London");
    expect(hours).toEqual([
      { hour: "2026-11-02T00:00", precipitationProbability: 5, temperatureC: 7.5 },
      { hour: "2026-11-02T14:00", precipitationProbability: 70, temperatureC: 0 },
    ]);
    const url = new URL(server.requests[0]?.path ?? "", server.url);
    expect(url.pathname).toBe("/v1/forecast");
    expect(url.searchParams.get("timezone")).toBe("Europe/London");
    expect(url.searchParams.get("start_date")).toBe("2026-11-02");
    expect(url.searchParams.get("end_date")).toBe("2026-11-02");
    expect(url.searchParams.get("hourly")).toBe("precipitation_probability,temperature_2m");
  });

  it("fails loudly on a bad response rather than inventing weather", async () => {
    const server = await fakeServer((_req, res) => json(res, 503, {}));
    servers.push(server);
    await expect(new OpenMeteoWeather({ baseUrl: server.url }).hourly("2026-11-02", 0, 0, "UTC")).rejects.toThrow(/503/);
  });
});
