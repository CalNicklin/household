import type { Runtime } from "../runtime.ts";

let current: Runtime | null = null;

/** DBOS workflows are registered at import time; the runtime they act on is set once at launch. */
export function setJobRuntime(rt: Runtime | null): void {
  current = rt;
}

export function jobRuntime(): Runtime {
  if (current === null) throw new Error("jobs used before launch");
  return current;
}
