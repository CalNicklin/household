import { createFileRoute } from "@tanstack/react-router";
import { RunScreen } from "../screens/Runs.tsx";

export const Route = createFileRoute("/runs/$id")({ component: RunRoute });

function RunRoute() {
  const { id } = Route.useParams();
  return <RunScreen id={id} />;
}
