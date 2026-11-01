import { createFileRoute } from "@tanstack/react-router";
import { ListsScreen } from "../screens/Lists.tsx";

export const Route = createFileRoute("/lists")({ component: ListsScreen });
