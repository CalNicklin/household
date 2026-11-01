import { ActionKind, type ShoppingRequest, ShoppingStatus } from "@household/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { say } from "../data/send.ts";
import { useTRPC } from "../data/trpc.ts";
import { BacklogRow, Button, ExternalLink, Grid3, Header, ListCard, Page, Row, Section, Text } from "../design-system/index.ts";
import { FooterComposer, navFor } from "./common.tsx";

const STATUS_LINE: Record<ShoppingStatus, (r: ShoppingRequest) => string> = {
  [ShoppingStatus.queued]: () => "Looking for it now",
  [ShoppingStatus.added]: (r) => (r.chosen === null ? "Added" : `Added ${r.chosen.name} · ${r.chosen.price}`),
  [ShoppingStatus.needsChoice]: () => "No exact match — which one?",
  [ShoppingStatus.failed]: () => "Couldn't find it; nothing was added",
  // HOU-148: with no shopping helper connected nothing was looked for, so it never says it couldn't find it.
  [ShoppingStatus.saved]: () => "Saved for when shopping is connected",
  [ShoppingStatus.dismissed]: () => "Dismissed",
};

/** A request that went nowhere can be dismissed with one tap, no guilt (HOU-148). */
const DISMISSABLE: ReadonlySet<ShoppingStatus> = new Set([ShoppingStatus.failed, ShoppingStatus.saved]);

/** AUT-3: no exact match → one question with two or three options to tap. */
function Request({ request }: { request: ShoppingRequest }) {
  const queryClient = useQueryClient();
  // HOU-148: a tap like any other (CH-8), so it is dismissed everywhere and the reply says what happened.
  const dismiss = () => {
    void say({ text: "Dismiss", ref: `shopping:${request.id}`, action: ActionKind.notToday }).then(() => queryClient.invalidateQueries());
  };
  const choose = (sku: string, name: string) => {
    void say({ text: name, ref: `shopping:${request.id}`, action: ActionKind.answer, value: sku }).then(() => queryClient.invalidateQueries());
  };
  return (
    <BacklogRow title={request.item} meta={STATUS_LINE[request.status](request)} tone={request.status === ShoppingStatus.added ? "suggestion" : "muted"}>
      {request.status === ShoppingStatus.needsChoice ? (
        <Row>
          {request.options.map((o) => (
            <Button key={o.sku} variant="secondary" onClick={() => choose(o.sku, o.name)}>
              {`${o.name} · ${o.price}`}
            </Button>
          ))}
        </Row>
      ) : null}
      {DISMISSABLE.has(request.status) ? (
        <Row>
          <Button variant="ghost" label={`Dismiss ${request.item}`} onClick={dismiss}>
            Dismiss
          </Button>
        </Row>
      ) : null}
      {request.runId === null ? null : (
        <Row>
          <Link to="/runs/$id" params={{ id: request.runId }}>
            See what it did
          </Link>
        </Row>
      )}
    </BacklogRow>
  );
}

export function ShopScreen() {
  const trpc = useTRPC();
  const shop = useQuery(trpc.shop.queryOptions());
  const data = shop.data;
  return (
    <Page label="Shop">
      <Header title="Shop" line={data?.deliveryDate === null || data === undefined ? "No delivery booked" : `Next delivery ${new Date(data.deliveryDate).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`} nav={navFor("/shop")} />
      <FooterComposer placeholder="Add to the shop, or ask the house anything" />
      <Grid3>
        <Section label="Asked for" tone="suggestion">
          <ListCard label="Asked for">
            {(data?.requests ?? []).map((r) => (
              <Request key={r.id} request={r} />
            ))}
          </ListCard>
          {data?.requests.length === 0 ? <Text tone="muted">Nothing asked for yet.</Text> : null}
        </Section>
        <Section label="In the basket">
          <ListCard label="In the basket">
            {(data?.basket ?? []).map((b) => (
              <BacklogRow key={b.sku} title={b.name} meta={`× ${b.quantity}`} />
            ))}
          </ListCard>
          {data === undefined ? null : (
            <Text tone="muted" small>
              <ExternalLink href={data.changeUrl}>Change the basket on the supermarket site</ExternalLink>
            </Text>
          )}
        </Section>
        <Section label="Our lists">
          <Text tone="muted" small>
            <Link to="/lists">Shopping and simple lists are on the Lists screen</Link>
          </Text>
        </Section>
      </Grid3>
    </Page>
  );
}
