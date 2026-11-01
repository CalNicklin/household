import { createFileRoute } from "@tanstack/react-router";
import { TraceScreen } from "../screens/Runs.tsx";

export const Route = createFileRoute("/trace/$id")({ component: TraceRoute });

function TraceRoute() {
  const { id } = Route.useParams();
  return <TraceScreen id={id} />;
}
