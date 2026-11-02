import { BacklogGroup, BacklogGroupLabel, type BacklogItem, BacklogTag, BacklogTagLabel } from "@household/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "../data/trpc.ts";
import { BacklogRow, Button, Chip, Chips, Footnote, Grid3, Header, ListCard, Page, Section, Text } from "../design-system/index.ts";
import { FooterComposer, navFor } from "./common.tsx";

/** CAP-3: the guessed tags as chips; one tap removes a wrong one, "Fix tags" shows the rest to add. */
function TagChips({ item }: { item: BacklogItem }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const setTags = useMutation(trpc.setTags.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }));
  const toggle = (tag: BacklogTag) => {
    const next = item.tags.includes(tag) ? item.tags.filter((t) => t !== tag) : [...item.tags, tag];
    setTags.mutate({ id: item.id, tags: next });
  };
  const shown = editing ? Object.values(BacklogTag) : item.tags;
  return (
    <Chips>
      {shown.map((tag) => (
        <Chip key={tag} on={item.tags.includes(tag)} onToggle={() => toggle(tag)} label={`${item.tags.includes(tag) ? "Remove" : "Add"} tag ${BacklogTagLabel[tag]} for ${item.text}`}>
          {BacklogTagLabel[tag]}
        </Chip>
      ))}
      <Chip on={false} onToggle={() => setEditing(!editing)} label={editing ? "Done fixing tags" : `Fix tags for ${item.text}`}>
        {editing ? "Done" : "Fix tags"}
      </Chip>
    </Chips>
  );
}

/** CAP-4: Could go soon / Waiting for the right moment / Just added. Nothing is ever overdue. */
export function BacklogScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const backlog = useQuery(trpc.backlog.queryOptions());
  const bringBack = useMutation(trpc.bringBack.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }));
  const [showParked, setShowParked] = useState(false);
  const data = backlog.data;
  const count = data?.count ?? 0;
  return (
    <Page label="Backlog">
      <Header title="Backlog" line={`${count} ${count === 1 ? "thing" : "things"} with no deadline · nothing here is overdue, ever`} nav={navFor("/backlog")} />
      <FooterComposer placeholder="Dump a job here, or ask the house anything" label="Add to the backlog, or ask the house" />
      <Grid3>
        <Section label={BacklogGroupLabel[BacklogGroup.soon]} tone="suggestion">
          <ListCard label={BacklogGroupLabel[BacklogGroup.soon]}>
            {(data?.soon ?? []).map(({ item, slot }) => (
              <BacklogRow key={item.id} title={item.text} meta={slot} tone="suggestion" />
            ))}
          </ListCard>
          {data?.soon.length === 0 ? <Text tone="muted">Nothing has a slot this week yet.</Text> : null}
        </Section>
        <Section label={BacklogGroupLabel[BacklogGroup.waiting]}>
          <ListCard label={BacklogGroupLabel[BacklogGroup.waiting]}>
            {(data?.waiting ?? []).map(({ item, waitingFor }) => (
              <BacklogRow key={item.id} title={item.text} meta={waitingFor} />
            ))}
          </ListCard>
        </Section>
        <Section label={BacklogGroupLabel[BacklogGroup.justAdded]}>
          <ListCard label={BacklogGroupLabel[BacklogGroup.justAdded]}>
            {(data?.justAdded ?? []).map(({ item, byline }) => (
              <BacklogRow key={item.id} title={item.text} meta={byline}>
                <TagChips item={item} />
              </BacklogRow>
            ))}
          </ListCard>
          <Text tone="muted" small>
            The app guesses what each job needs from what you typed. Tap a tag to correct it; then it knows when to offer this.
          </Text>
        </Section>
      </Grid3>
      <Footnote>
        <Text tone="muted">{`${data?.parked.length ?? 0} more, parked · things you said “not now” to three times`}</Text>
        <Button variant="link" onClick={() => setShowParked(!showParked)}>
          {showParked ? "Hide parked" : "Show parked"}
        </Button>
      </Footnote>
      {showParked ? (
        <Section label={BacklogGroupLabel[BacklogGroup.parked]}>
          <ListCard label={BacklogGroupLabel[BacklogGroup.parked]}>
            {(data?.parked ?? []).map((item) => (
              <BacklogRow key={item.id} title={item.text} meta="Parked until you bring it back">
                <Button variant="secondary" onClick={() => bringBack.mutate({ id: item.id })}>
                  Bring back
                </Button>
              </BacklogRow>
            ))}
          </ListCard>
        </Section>
      ) : null}
    </Page>
  );
}
