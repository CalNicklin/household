import { ActionKind, ActionLabel, BacklogGroup, BacklogGroupLabel, type BacklogItem, BacklogTag, BacklogTagLabel } from "@household/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "../data/trpc.ts";
import { useUndo } from "../data/undo.tsx";
import { BacklogRow, Button, Chip, Chips, Footnote, Grid3, Header, ListCard, Menu, Page, Section, Text } from "../design-system/index.ts";
import { FooterComposer, navFor, useBacklogTaps } from "./common.tsx";

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

/**
 * HOU-158: "…" then Delete takes an item off the backlog, anyone's, with Undo for a few seconds. Only a
 * person's tap reaches the delete (PRV-1). HOU-179: an active item's menu also has Done (with Undo, as
 * Delete) and Pencil it in, or Move once it is pencilled in; both go as the person's own tap (CH-8).
 */
const backlogKey = (item: BacklogItem) => `backlog:${item.id}`;

/** HOU-179: which menu a row gets. */
type RowKind = "active" | "pencilled" | "parked";

function useBacklogMenu() {
  const trpc = useTRPC();
  const { isDeleted, remove } = useUndo();
  const taps = useBacklogTaps();
  const del = useMutation(trpc.removeBacklog.mutationOptions());
  const deleteEntry = (item: BacklogItem) => ({ key: "delete", label: "Delete", onSelect: () => remove(backlogKey(item), `Deleted “${item.text}”`, () => del.mutateAsync({ id: item.id })) });
  return {
    shown: <T,>(rows: readonly T[], item: (row: T) => BacklogItem) => rows.filter((r) => !isDeleted(backlogKey(item(r)))),
    /** An active row gets Done and Pencil it in (Move once pencilled in); a parked row, Delete only. */
    menu: (item: BacklogItem, row: RowKind) => {
      const pencil = row === "pencilled" ? "Move" : ActionLabel[ActionKind.accept];
      const active =
        row === "parked"
          ? []
          : [
              { key: "done", label: ActionLabel[ActionKind.done], onSelect: () => taps.done(backlogKey(item), backlogKey(item), item.text) },
              { key: "pencil", label: pencil, onSelect: () => taps.pencil(backlogKey(item), pencil) },
            ];
      return <Menu icon="more" label={`Actions for ${item.text}`} entries={[...active, deleteEntry(item)]} />;
    },
  };
}

/** CAP-4: Could go soon / Waiting for the right moment / Just added. Nothing is ever overdue. */
export function BacklogScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const backlog = useQuery(trpc.backlog.queryOptions());
  const bringBack = useMutation(trpc.bringBack.mutationOptions({ onSuccess: () => queryClient.invalidateQueries() }));
  const [showParked, setShowParked] = useState(false);
  const { shown, menu } = useBacklogMenu();
  const data = backlog.data;
  const soon = shown(data?.soon ?? [], (r) => r.item);
  const waiting = shown(data?.waiting ?? [], (r) => r.item);
  const justAdded = shown(data?.justAdded ?? [], (r) => r.item);
  const parked = shown(data?.parked ?? [], (r) => r);
  // Not parked, and not just deleted here.
  const count = soon.length + waiting.length + justAdded.length;
  return (
    <Page label="Backlog">
      <Header title="Backlog" line={`${count} ${count === 1 ? "thing" : "things"} with no deadline · nothing here is overdue, ever`} nav={navFor("/backlog")} />
      <FooterComposer placeholder="Dump a job here, or ask the house anything" label="Add to the backlog, or ask the house" />
      <Grid3>
        <Section label={BacklogGroupLabel[BacklogGroup.soon]} tone="suggestion">
          <ListCard label={BacklogGroupLabel[BacklogGroup.soon]}>
            {soon.map(({ item, slot, pencilled }) => (
              <BacklogRow key={item.id} title={item.text} meta={slot} tone="suggestion" menu={menu(item, pencilled ? "pencilled" : "active")} />
            ))}
          </ListCard>
          {data !== undefined && soon.length === 0 ? <Text tone="muted">Nothing has a slot this week yet.</Text> : null}
        </Section>
        <Section label={BacklogGroupLabel[BacklogGroup.waiting]}>
          <ListCard label={BacklogGroupLabel[BacklogGroup.waiting]}>
            {waiting.map(({ item, waitingFor }) => (
              <BacklogRow key={item.id} title={item.text} meta={waitingFor} menu={menu(item, "active")} />
            ))}
          </ListCard>
        </Section>
        <Section label={BacklogGroupLabel[BacklogGroup.justAdded]}>
          <ListCard label={BacklogGroupLabel[BacklogGroup.justAdded]}>
            {justAdded.map(({ item, byline }) => (
              <BacklogRow key={item.id} title={item.text} meta={byline} menu={menu(item, "active")}>
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
        <Text tone="muted">{`${parked.length} more, parked · things you said “not now” to three times`}</Text>
        <Button variant="link" onClick={() => setShowParked(!showParked)}>
          {showParked ? "Hide parked" : "Show parked"}
        </Button>
      </Footnote>
      {showParked ? (
        <Section label={BacklogGroupLabel[BacklogGroup.parked]}>
          <ListCard label={BacklogGroupLabel[BacklogGroup.parked]}>
            {parked.map((item) => (
              <BacklogRow key={item.id} title={item.text} meta="Parked until you bring it back" menu={menu(item, "parked")}>
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
