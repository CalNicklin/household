import { ActionKind, type NotifyInput, type ProductOption, Urgency } from "@household/contracts";

/**
 * AUT-3: when the helper found no exact match it added nothing; the person who asked gets one question
 * with the options it found to tap. Plain code, never the model's decision. Nobody to ask, no question.
 */
export function shoppingQuestion(request: { id: string; item: string }, options: ProductOption[], person: string | null): NotifyInput | null {
  if (person === null) return null;
  const ref = `shopping:${request.id}`;
  return {
    person,
    message: `No exact match for "${request.item}". Which one?`,
    urgency: Urgency.urgent,
    actions: options.map((o) => ({ kind: ActionKind.answer, label: o.name, ref, value: o.sku })),
    key: `${ref}:question`,
    countsTowardsBudget: true,
  };
}
