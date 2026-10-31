import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "../screens/Home.tsx";

export const Route = createFileRoute("/")({ component: HomeScreen });
