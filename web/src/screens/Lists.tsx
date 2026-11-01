import { type List, type ListItem, type ListsView, ListWriteOutcome } from "@household/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "../data/trpc.ts";
import { AddItemField, Button, ChecklistCard, ChecklistTitle, ChecklistTitleEditor, CheckRow, Confirm, Grid3, Header, Menu, Page, Row, Text } from "../design-system/index.ts";
import { FooterComposer, navFor } from "./common.tsx";

const NEW_LIST = { name: "New list", emoji: "📝" } as const;
const alreadyThere = (text: string) => `"${text}" is already on this list — try a different name.`;
const NOT_SAVED = "That didn't save — check the connection and try again.";

/**
 * A write that resolves to a message to show (or null when it saved). A failed request shows a
 * message instead of being lost; the list is refetched either way.
 */
type Refusal = string | null;
async function saved(write: () => Promise<{ outcome: ListWriteOutcome }>, text: string): Promise<Refusal> {
  try {
    return (await write()).outcome === ListWriteOutcome.duplicate ? alreadyThere(text) : null;
  } catch {
    return NOT_SAVED;
  }
}

/** Change the lists in place before the server answers (the server's answer then arrives over /api/live). */
function useListsCache() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const key = trpc.lists.queryKey();
  const patchItem = (id: string, change: (item: ListItem) => ListItem | null) =>
    queryClient.setQueryData<ListsView>(key, (old) => old?.map((l) => ({ ...l, items: l.items.flatMap((i) => (i.id === id ? [change(i)].filter((x) => x !== null) : [i])) })));
  return { patchItem, refresh: () => queryClient.invalidateQueries({ queryKey: key }) };
}

function ListPanel({ list }: { list: List }) {
  const trpc = useTRPC();
  const { patchItem, refresh } = useListsCache();
  const settle = { onSettled: refresh };
  const add = useMutation(trpc.addListItem.mutationOptions(settle));
  const check = useMutation(trpc.setListItemChecked.mutationOptions(settle));
  const rename = useMutation(trpc.renameListItem.mutationOptions(settle));
  const removeItem = useMutation(trpc.removeListItem.mutationOptions(settle));
  const update = useMutation(trpc.updateList.mutationOptions(settle));
  const removeList = useMutation(trpc.removeList.mutationOptions(settle));
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const title = editing ? (
    <ChecklistTitleEditor
      emoji={list.emoji}
      name={list.name}
      onCancel={() => setEditing(false)}
      onSave={(next) => {
        setEditing(false);
        if (next.name !== list.name || next.emoji !== list.emoji) update.mutate({ id: list.id, name: next.name, emoji: next.emoji });
      }}
    />
  ) : (
    <ChecklistTitle
      emoji={list.emoji}
      name={list.name}
      menu={
        <Menu
          label={`Actions for ${list.name}`}
          entries={[
            { key: "rename", label: "Rename / emoji", onSelect: () => setEditing(true) },
            { key: "delete", label: "Delete list", onSelect: () => setDeleting(true) },
          ]}
        />
      }
    />
  );

  return (
    <ChecklistCard
      label={list.name}
      title={
        <>
          {title}
          {deleting ? (
            <Confirm
              question={`Delete “${list.name}” and everything on it, for everyone?`}
              confirmLabel="Delete list"
              onCancel={() => setDeleting(false)}
              onConfirm={() => {
                setDeleting(false);
                removeList.mutate({ id: list.id });
              }}
            />
          ) : null}
        </>
      }
      adder={
        <AddItemField
          label={`Add an item to ${list.name}`}
          onAdd={(text) => saved(() => add.mutateAsync({ listId: list.id, text }), text)}
        />
      }
    >
      {list.items.map((item) => (
        <CheckRow
          key={item.id}
          text={item.text}
          checked={item.checked}
          onToggle={(checked) => {
            patchItem(item.id, (i) => ({ ...i, checked }));
            check.mutate({ id: item.id, checked });
          }}
          onRename={(text) => saved(() => rename.mutateAsync({ id: item.id, text }), text)}
          onRemove={() => {
            patchItem(item.id, () => null);
            removeItem.mutate({ id: item.id });
          }}
        />
      ))}
    </ChecklistCard>
  );
}

/**
 * CAP-6: shopping and simple lists live in the app. Tick, add, rename and delete here; anything said
 * or typed to the house can add to them too, and every open screen shows a change straight away.
 */
export function ListsScreen() {
  const trpc = useTRPC();
  const lists = useQuery(trpc.lists.queryOptions());
  const { refresh } = useListsCache();
  const create = useMutation(trpc.createList.mutationOptions({ onSettled: refresh }));
  return (
    <Page label="Lists">
      <Header title="Lists" line="Shopping and simple lists, shared by everyone" nav={navFor("/lists")} />
      <FooterComposer placeholder="“Add wrapping paper to the presents list”" />
      <Grid3>
        {(lists.data ?? []).map((l) => (
          <ListPanel key={l.id} list={l} />
        ))}
      </Grid3>
      {lists.data?.length === 0 ? <Text tone="muted">No lists yet.</Text> : null}
      <Row>
        <Button variant="secondary" onClick={() => create.mutate({ ...NEW_LIST })}>
          New list
        </Button>
      </Row>
    </Page>
  );
}
