import { createFileRoute } from "@tanstack/react-router";
import { LoginScreen } from "../screens/Login.tsx";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => (typeof search["next"] === "string" ? { next: search["next"] } : {}),
  component: LoginRoute,
});

function LoginRoute() {
  const { next } = Route.useSearch();
  return <LoginScreen next={next} />;
}
