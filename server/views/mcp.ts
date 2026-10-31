import type { Arrival, BacklogScreen, ScreenView } from "@household/contracts";
import type { Runtime } from "../runtime.ts";
import { localDate } from "../time.ts";
import { backlogScreen } from "./backlog.ts";
import { screenView } from "./screen.ts";

/** CH-9: what an MCP client may read — today, the backlog, arrivals. Read from the query layer only. */
export async function mcpToday(rt: Runtime, person: string): Promise<ScreenView> {
  return screenView(rt, person, localDate(rt.ports.clock.now(), rt.timeZone));
}

export async function mcpBacklog(rt: Runtime): Promise<BacklogScreen> {
  return backlogScreen(rt);
}

export async function mcpArrivals(rt: Runtime): Promise<Arrival[]> {
  const today = localDate(rt.ports.clock.now(), rt.timeZone);
  return (await rt.system("mcp").parcels.all()).filter((a) => a.expectedDate >= today);
}
