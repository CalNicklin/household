import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createSupermarketApp, searchCatalogue } from "./app.ts";

describe("practice supermarket", () => {
  test("[QA-9] search behaves like a real shop: close matches, not just exact ones", () => {
    expect(searchCatalogue("oat milk").map((p) => p.sku)).toEqual(["oat-1l", "oat-semi-1l"]);
    expect(searchCatalogue("nappies").map((p) => p.sku)).toEqual(["nappies-4", "nappies-5"]);
    expect(searchCatalogue("unicorn steaks")).toEqual([]);
  });

  test("[QA-9] the shop needs a login and starts with the practice basket", async () => {
    const { app } = createSupermarketApp({ username: "u", password: "p" });
    expect((await app.request("/basket")).status).toBe(302);
    const login = await app.request("/login", { method: "POST", body: new URLSearchParams({ username: "u", password: "p" }) });
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const basket = await app.request("/basket", { headers: { cookie } });
    expect(await basket.text()).toContain("Fusilli Pasta 500g");
    const json = z.object({ items: z.array(z.object({ sku: z.string() })) }).parse(await (await app.request("/practice-api/basket")).json());
    expect(json.items.map((i) => i.sku)).toEqual(["bananas", "pasta"]);
  });
});
