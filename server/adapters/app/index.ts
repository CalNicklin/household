import { type Attachment, AttachmentKind, Channel, zAppMessageInput, zAppMessageOutput } from "@household/contracts";
import { accept } from "../../coordinator/accept.ts";
import type { Adapter } from "../registry.ts";

/**
 * The app as a channel (CH-2): the composer and every button post here. A tap is a normal message
 * with a ref attachment (CH-8); speech arrives as text with `spoken` (MOM-8). The person is the
 * logged-in session (CH-3); there is no business logic here (CH-11).
 */
export const adapter: Adapter = {
  name: "app",
  privateRoutes: (app, rt) => {
    app.post("/api/messages", async (c) => {
      const body = zAppMessageInput.parse(await c.req.json());
      const attachments: Attachment[] = [];
      if (body.ref !== undefined) {
        const ref: Attachment = { kind: AttachmentKind.ref, ref: body.ref };
        if (body.action !== undefined) Object.assign(ref, { action: body.action });
        if (body.value !== undefined) Object.assign(ref, { value: body.value });
        attachments.push(ref);
      }
      const accepted = await accept(rt, {
        household: rt.env.HOUSEHOLD_ID,
        person: c.get("person"),
        channel: Channel.app,
        text: body.text,
        attachments,
        dedupeKey: `app:${c.get("person")}:${body.clientId}`,
        receivedAt: rt.ports.clock.now().toISOString(),
      });
      return c.json(zAppMessageOutput.parse(accepted));
    });
  },
};
