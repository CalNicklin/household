import { createFileRoute } from "@tanstack/react-router";
import { WeekScreen } from "../screens/Week.tsx";

export const Route = createFileRoute("/week")({ component: WeekScreen });
