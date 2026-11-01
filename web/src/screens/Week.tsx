import { useQuery } from "@tanstack/react-query";
import { BlockList } from "../blocks/BlockRenderer.tsx";
import { useTRPC } from "../data/trpc.ts";
import { Header, Page, Section, Stack, Text } from "../design-system/index.ts";
import { FooterComposer, navFor, useBlockHandlers } from "./common.tsx";

/** The week ahead, one section per day, from the same block vocabulary. */
export function WeekScreen() {
  const trpc = useTRPC();
  const week = useQuery(trpc.week.queryOptions());
  const handlers = useBlockHandlers(0);
  const days = week.data?.days ?? [];
  return (
    <Page label="Week">
      <Header title="This week" line="What's fixed, and what could fit" nav={navFor("/week")} />
      <Stack>
        {days.length === 0 && !week.isPending ? <Text tone="muted">Nothing planned for the week yet.</Text> : null}
        {days.map((day) => {
          // HOU-153: filter first, so a day whose blocks were all dismissed still says so.
          const shown = day.blocks.filter((b) => !handlers.isHidden(b));
          return (
            <Section key={day.date} label={day.label}>
              {shown.length === 0 ? <Text tone="muted">Nothing fixed.</Text> : <BlockList blocks={shown} handlers={handlers} today={day.today} />}
            </Section>
          );
        })}
      </Stack>
      <FooterComposer placeholder="Tell me something, or ask" />
    </Page>
  );
}
