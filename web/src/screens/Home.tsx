import { BlockType } from "@household/contracts";
import { useQuery } from "@tanstack/react-query";
import { BlockLayout } from "../blocks/BlockRenderer.tsx";
import { useTRPC } from "../data/trpc.ts";
import { Header, Page, PageBody, Text } from "../design-system/index.ts";
import { FooterComposer, navFor, useBlockHandlers } from "./common.tsx";

const FALLBACK_PLACEHOLDER = "Tell me something, or ask — “we're out of oat milk”, “slow day, one thing?”";

function today(): string {
  return new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

/** The morning glance: whatever blocks the server composed, in its order (HOME-7). */
export function HomeScreen() {
  const trpc = useTRPC();
  const screen = useQuery(trpc.screen.queryOptions({}));
  const version = screen.data?.version ?? 0;
  const handlers = useBlockHandlers(version);
  const blocks = (screen.data?.blocks ?? []).filter((b) => !handlers.isHidden(b));
  const composer = blocks.find((b) => b.type === BlockType.composer);
  const nav = navFor("/");
  return (
    <Page label="Today">
      <BlockLayout
        blocks={blocks}
        handlers={handlers}
        nav={nav}
        fallbackHeader={<Header title={today()} line={screen.isPending ? "" : "Today's plan is being put together."} nav={nav} />}
      />
      {screen.isError ? (
        <PageBody>
          <Text tone="muted">Couldn't reach the house just now. Showing what we had.</Text>
        </PageBody>
      ) : null}
      <FooterComposer placeholder={composer?.type === BlockType.composer ? composer.placeholder : FALLBACK_PLACEHOLDER} />
    </Page>
  );
}
