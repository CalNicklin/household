import { Domain } from "@household/contracts";
import type { Runtime } from "../runtime.ts";

/** PRV-7: everything about one person, from every domain, through each domain's router. */
export async function exportPerson(rt: Runtime, person: string): Promise<Record<string, unknown>> {
  const api = rt.system("PRV-7 export");
  const out: Record<string, unknown> = {
    [Domain.household]: await api.household.exportPerson({ person }),
    [Domain.backlog]: await api.backlog.exportPerson({ person }),
    [Domain.plans]: await api.plans.exportPerson({ person }),
    [Domain.learning]: await api.learning.exportPerson({ person }),
    [Domain.wellbeing]: await api.wellbeing.exportPerson({ person }),
    [Domain.jobs]: await api.jobs.exportPerson({ person }),
    [Domain.health]: await api.health.exportPerson({ person }),
    [Domain.shopping]: await api.shopping.exportPerson({ person }),
    memory: await rt.ports.memory.recall({ household: rt.env.HOUSEHOLD_ID, person }, ""),
  };
  return out;
}

/** PRV-7: delete everything about one person; their name stays so the house still knows who lives here. */
export async function deletePerson(rt: Runtime, person: string): Promise<void> {
  const api = rt.system("PRV-7 delete");
  await api.backlog.deletePerson({ person });
  await api.plans.deletePerson({ person });
  await api.learning.deletePerson({ person });
  await api.wellbeing.deletePerson({ person });
  await api.jobs.deletePerson({ person });
  await api.health.deletePerson({ person });
  await api.shopping.deletePerson({ person });
  await api.household.deletePerson({ person });
  await rt.ports.memory.forget({ household: rt.env.HOUSEHOLD_ID, person });
}
