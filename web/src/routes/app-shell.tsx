import { createFileRoute } from "@tanstack/react-router";

/** The path the SPA shell is prerendered from. Nobody navigates here; it renders nothing of its own. */
export const Route = createFileRoute("/app-shell")({ component: () => null });
