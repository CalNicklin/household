import { createFileRoute } from "@tanstack/react-router";
import { RunLogScreen } from "../screens/Runs.tsx";

export const Route = createFileRoute("/runs/")({ component: RunLogScreen });
