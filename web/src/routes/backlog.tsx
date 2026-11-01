import { createFileRoute } from "@tanstack/react-router";
import { BacklogScreen } from "../screens/Backlog.tsx";

export const Route = createFileRoute("/backlog")({ component: BacklogScreen });
