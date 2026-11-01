import { createFileRoute } from "@tanstack/react-router";
import { SpendScreen } from "../screens/Runs.tsx";

export const Route = createFileRoute("/spend")({ component: SpendScreen });
