import { createFileRoute } from "@tanstack/react-router";
import { ShopScreen } from "../screens/Shop.tsx";

export const Route = createFileRoute("/shop")({ component: ShopScreen });
