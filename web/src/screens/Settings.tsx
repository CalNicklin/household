import {
  DeliveryChannel,
  DeliveryChannelLabel,
  type LearnedSentence,
  type Rule,
  Urgency,
  UrgencyLabel,
  WeekdayLabel,
  WellbeingFactorLabel,
} from "@household/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "../data/trpc.ts";
import { BacklogRow, Button, Card, Field, Form, Grid3, Header, ListCard, Page, Row, Section, Segmented, Stack, Stepper, Table, Text, TextInput, Toggle } from "../design-system/index.ts";
import { navFor } from "./common.tsx";

const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

function ruleSentence(rule: Rule): string {
  const spec = rule.spec;
  switch (spec.kind) {
    case "bins":
      return `Bins are collected on ${WeekdayLabel[spec.collectionDay]}: ${spec.evenWeeks.join(" + ")} one week, ${spec.oddWeeks.join(" + ")} the next.`;
    case "chore":
      return `${spec.title} every ${spec.everyDays} days.`;
  }
}

function everyDaysIn(text: string): number | null {
  const m = /every (\d+) days?/.exec(text);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** LRN-7: everything it has learned, as plain sentences. Delete one and it forgets. */
function Learned({ sentence }: { sentence: LearnedSentence }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = { onSuccess: () => queryClient.invalidateQueries() };
  const forget = useMutation(trpc.forgetSentence.mutationOptions(refresh));
  const edit = useMutation(trpc.editRhythm.mutationOptions(refresh));
  const every = sentence.kind === "rhythm" ? everyDaysIn(sentence.text) : null;
  return (
    <BacklogRow title={sentence.text} meta="">
      <Row>
        {every === null ? null : <Stepper label={`days between, ${sentence.text}`} value={every} min={1} max={60} format={(n) => `about every ${n} days`} onChange={(n) => edit.mutate({ id: sentence.id, everyDays: n })} />}
        <Button variant="ghost" onClick={() => forget.mutate({ id: sentence.id, kind: sentence.kind })}>
          Forget this
        </Button>
      </Row>
    </BacklogRow>
  );
}

function HealthEntry() {
  const trpc = useTRPC();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [heavy, setHeavy] = useState(true);
  const [saved, setSaved] = useState(false);
  const add = useMutation(trpc.addHealthEntry.mutationOptions({ onSuccess: () => setSaved(true) }));
  return (
    <Section label="Health tracking (only you)">
      <Card>
        <Form label="Add a health day" onSubmit={() => add.mutate({ date, heavy })}>
          <Text tone="muted" small>
            Stored separately and only you can add to it. It counts towards your score only if you turn that on above, and the app never mentions it.
          </Text>
          <Field label="Day">
            <TextInput label="Day" type="date" value={date} onChange={setDate} />
          </Field>
          <Field label="A heavy day">
            <Toggle label="A heavy day" checked={heavy} onChange={setHeavy} />
          </Field>
          <Button type="submit" variant="primary">
            Save
          </Button>
          {saved ? <Text tone="suggestion">Saved.</Text> : null}
        </Form>
      </Card>
    </Section>
  );
}

export function SettingsScreen() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = { onSuccess: () => queryClient.invalidateQueries() };
  const settings = useQuery(trpc.settings.queryOptions());
  const me = useQuery(trpc.me.queryOptions());
  const update = useMutation(trpc.updateMySettings.mutationOptions(refresh));
  const household = useMutation(trpc.updateHousehold.mutationOptions(refresh));
  const addIdea = useMutation(trpc.addWellbeingIdea.mutationOptions(refresh));
  const removeIdea = useMutation(trpc.removeWellbeingIdea.mutationOptions(refresh));
  const [idea, setIdea] = useState("");
  const data = settings.data;
  if (data === undefined) {
    return (
      <Page label="Settings">
        <Header title="Settings" nav={navFor("/settings")} />
      </Page>
    );
  }
  const mine = data.me;
  const channelOptions = Object.values(DeliveryChannel).map((c) => ({ value: c, label: DeliveryChannelLabel[c] }));
  return (
    <Page label="Settings">
      <Header title="Settings" line={me.data === undefined ? "" : `For ${me.data.name}`} nav={navFor("/settings")} />
      <Grid3>
        <Stack>
          <Section label="Messages">
            <Card>
              <Field label="Messages a day" hint="Anything over this waits for the morning screen">
                <Stepper label="messages a day" value={mine.dailyMessageBudget} min={0} max={20} onChange={(n) => update.mutate({ dailyMessageBudget: n })} />
              </Field>
              <Field label="Quiet from">
                <Stepper label="quiet hours start" value={mine.quietStartHour} min={0} max={23} format={hour} onChange={(n) => update.mutate({ quietStartHour: n })} />
              </Field>
              <Field label="Quiet until">
                <Stepper label="quiet hours end" value={mine.quietEndHour} min={0} max={23} format={hour} onChange={(n) => update.mutate({ quietEndHour: n })} />
              </Field>
            </Card>
          </Section>
          <Section label="Where things go">
            <Card>
              {Object.values(Urgency).map((u) => (
                <Field key={u} label={UrgencyLabel[u]}>
                  <Segmented label={`Channel for ${UrgencyLabel[u]}`} value={mine.routing[u] ?? DeliveryChannel.screen} options={channelOptions} onChange={(c) => update.mutate({ routing: { ...mine.routing, [u]: c } })} />
                </Field>
              ))}
            </Card>
          </Section>
          <Section label="Privacy">
            <Card>
              <Field label="Keep messages for 30 days" hint="To fix problems. Turn off and nothing is kept">
                <Toggle label="Keep messages for 30 days" checked={data.household.retainMessages} onChange={(v) => household.mutate({ retainMessages: v })} />
              </Field>
            </Card>
          </Section>
        </Stack>
        <Stack>
          <Section label="Heavy days">
            <Card>
              <Field label="Notice heavy days" hint="Only from what the app already knows">
                <Toggle label="Notice heavy days" checked={mine.wellbeingEnabled} onChange={(v) => update.mutate({ wellbeingEnabled: v })} />
              </Field>
              {me.data?.healthOwner === true ? (
                <Field label="Count my health tracking">
                  <Toggle label="Count my health tracking" checked={mine.healthInScore} onChange={(v) => update.mutate({ healthInScore: v })} />
                </Field>
              ) : null}
            </Card>
            {data.wellbeing.enabled && data.wellbeing.recent.length > 0 ? (
              <Table
                label="What went into the score"
                head={["Day", "Score", "Made from"]}
                rows={data.wellbeing.recent.map((s) => [s.date, `${s.score}${s.heavy ? " · heavy" : ""}`, s.factors.map((f) => `${WellbeingFactorLabel[f.factor]}: ${f.value} (+${f.points})`).join("; ")])}
              />
            ) : null}
          </Section>
          <Section label="Small things that help">
            <ListCard label="Small things that help">
              {data.ideas.map((i) => (
                <BacklogRow key={i.id} title={i.text} meta="">
                  <Button variant="ghost" onClick={() => removeIdea.mutate({ id: i.id })}>
                    Remove
                  </Button>
                </BacklogRow>
              ))}
            </ListCard>
            <Form
              label="Add a small thing"
              onSubmit={() => {
                if (idea.trim() === "") return;
                addIdea.mutate({ text: idea.trim() });
                setIdea("");
              }}
            >
              <Row>
                <TextInput label="A small thing that helps" value={idea} onChange={setIdea} placeholder="A walk, an early night…" />
                <Button type="submit" variant="secondary">
                  Add
                </Button>
              </Row>
            </Form>
          </Section>
          {me.data?.healthOwner === true ? <HealthEntry /> : null}
        </Stack>
        <Stack>
          <Section label="What it has learned">
            <ListCard label="What it has learned">
              {data.learned.map((s) => (
                <Learned key={`${s.kind}:${s.id}`} sentence={s} />
              ))}
            </ListCard>
            {data.learned.length === 0 ? <Text tone="muted">Nothing yet. It learns from what you mark done and dismiss.</Text> : null}
          </Section>
          <Section label="House rules">
            <ListCard label="House rules">
              {data.rules.map((r) => (
                <BacklogRow key={r.id} title={ruleSentence(r)} meta="Written by one of you; the app only reads it" />
              ))}
            </ListCard>
          </Section>
        </Stack>
      </Grid3>
    </Page>
  );
}
