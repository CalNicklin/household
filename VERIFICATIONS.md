# Household Coordinator — Verifications

Oct 31, 2026 · @Cal

## How to read this

Each line below describes something that will be true when the app is finished. We tick a line only when we can see it working on the kitchen iPad or in a test.

**Chloe: read these sections** — Morning glance, Capture, In the moment, Proactive nudges, Automations, Privacy and safety, Learning, Wellbeing, and Out of scope. They describe what you will see and what the app is allowed to do. Change any line you disagree with.

**Cal only** — Channels, Platform, Quality and dev workflow, and Code. These describe how it is built.

Every line has an ID so it can become one task for the building agent. Lines marked **(gate)** must be done before the rest of their section.

## Morning glance

You can look at the kitchen iPad when you wake up and know what today needs, without touching it.

- [ ] HOME-1 **(gate)** The home screen shows three sections: Now, Later today, Tomorrow. They come from our Google calendars (Cal's, Chloe's and the shared one) and update within a minute of a change.
- [ ] HOME-2 One line at the top says what shapes today: the weather window, when it gets dark, who is home and until when.
- [ ] HOME-3 Every suggestion says why it is there, in one line you could check yourself. For example "dry until 2pm" or "you are both out on Thursday".
- [ ] HOME-4 You can dismiss any suggestion with one tap. Nothing ever becomes "overdue".
- [ ] HOME-5 When you tap Done or Not today, the screen updates straight away, on the iPad and on your phone.
- [ ] HOME-6 The app installs on the iPad like a normal app, opens full screen, and still shows today's plan after being left open all week.
- [ ] HOME-7 The server decides which blocks appear on the screen and in what order. The screen itself has no fixed layout.
- [ ] HOME-8 If you tell it "slow day", the screen rearranges itself without anyone changing code.
- [ ] HOME-9 Links to Backlog, Shop and Week exist but stay out of the way. No tab bar, no red badges.
- [ ] HOME-10 On a phone the same screen fits in one column with nothing cut off, and every button is big enough to tap.
- [ ] HOME-11 Tomorrow's plan is ready by 6am every day, even if nobody opens the app. Every day's plan is kept.

## Capture

Anything either of us remembers can be noted in under five seconds, from anywhere, and will not be lost or nag us.

- [ ] CAP-1 **(gate)** Type or say a thought anywhere (the app, WhatsApp, email) and it appears on the Backlog for both of us within five seconds.
- [ ] CAP-2 Backlog items have no due date and no priority. They only have tags for what they need: how long, daylight, dry weather, both of us home, no kids around, a phone call, a trip out, office hours.
- [ ] CAP-3 The app guesses the tags from what you wrote and shows them as chips. One tap fixes a wrong one.
- [ ] CAP-4 The Backlog screen has three groups: Could go soon (it has found a slot and says when), Waiting for the right moment (it says what it is waiting for), and Just added.
- [ ] CAP-5 If you say "not now" to something three times, it moves to Parked and stops being offered until you bring it back.
- [ ] CAP-6 Shopping and simple lists live in the app. Anything said or typed can add to them, and both of us see the same list straight away.
- [ ] CAP-7 Regular chores (which bins, watering the plants, changing the beds) are set up once as rules and appear on the right day.
- [ ] CAP-8 Nursery term dates, closures and session days are known to the app and show up on the day they matter.
- [ ] CAP-9 When an order confirmation email arrives for either of us, an Arriving row appears with the shop and the expected day. Nobody types anything.

## In the moment

On a hard day the app makes the day smaller instead of moving things around, and answers "what should I do?" in one line.

- [ ] MOM-1 **(gate)** Say "slow day" (or sick day, or away) anywhere, and the home screen changes to show one suggested thing and a short list of what is still happening anyway.
- [ ] MOM-2 Ask "if I do one thing, what should it be?" and you get one answer with a reason. Never a list, and it never asks you a question first.
- [ ] MOM-3 A slow day applies to the whole house. Set it on your phone and the iPad shows it within two seconds.
- [ ] MOM-4 A slow day ends at midnight unless you extend it. The next morning is normal.
- [ ] MOM-5 Fixed things (bins, nursery) still show on a slow day. Only the app's own suggestions are hidden.
- [ ] MOM-6 Say "Cal can do it" and the item moves to Cal, who gets one message about it.
- [ ] MOM-7 Tap any item and you can talk about it straight away. "Move this to tomorrow" works without saying what "this" is.
- [ ] MOM-8 Talking to the app works the same as typing. Nothing is only available one way.
- [ ] MOM-9 The app never replies with more than three sentences unless you ask for more.

## Proactive nudges

The app does the remembering. Things that currently live in one of our heads arrive as a message at a useful time, and no more often than needed.

- [ ] PRO-1 **(gate)** If we are both going to an evening event and no babysitter is booked, a warning appears a week before, and one of us gets a reminder to message a named sitter five days before.
- [ ] PRO-2 Reply "Hannah's doing Thursday" and the warning disappears everywhere.
- [ ] PRO-3 The right bins for that week appear under Later today the evening before collection, and whoever is home gets a message at 7pm.
- [ ] PRO-4 If the forecast is dry for three hours or more and someone is home at the start, a suggestion to put a wash on appears that morning. It is shown on the screen, never sent as a message.
- [ ] PRO-5 On the morning of a delivery that needs someone in, you get a message. Deliveries that can be left get no message.
- [ ] PRO-6 The app offers at most one backlog item a day, and only once.
- [ ] PRO-7 Each of us can set how many messages a day we want (three to start) and quiet hours (9pm to 7am to start). Anything over the limit waits for the morning screen.
- [ ] PRO-8 All these reminders are fixed rules with tests, not AI guesses. The AI only chooses which backlog item fits a gap and how to word things.
- [ ] PRO-9 Dismiss a message on your phone and it is dismissed everywhere. Nothing is shown twice.
- [ ] PRO-10 Nursery parties, inset days and closures show under Tomorrow the day before, with who is covering, or a warning if nobody is.

## Channels

Every way in (the app, WhatsApp, email, a timer, another AI) turns into the same kind of message. Every way out goes through one send function with a rule for which channel to use.

- [ ] CH-1 **(gate)** There is one shape for an incoming message: household, person, channel, text, attachments, a duplicate-check key, and the time received. Every channel adapter produces exactly this.
- [ ] CH-2 Adapters exist for the app, WhatsApp or Telegram, email, the MCP server and timers or webhooks. Each has a test that sends a message and checks the same job lands on the queue.
- [ ] CH-3 Who sent it is worked out at the edge. A WhatsApp number, an email address or an app login maps to Cal or Chloe before the coordinator sees it. Unknown senders are dropped and logged.
- [ ] CH-4 A message delivered twice (WhatsApp retries, a calendar webhook firing again) creates one job, not two. A test proves it.
- [ ] CH-5 Timers are messages too: 5:30am plan, hourly refresh, 7pm bins. A missed timer shows in the run log.
- [ ] CH-6 A change in Google Calendar sends a message that re-plans only the day affected.
- [ ] CH-7 There is one send function: `notify(person, message, urgency, actions)`. A table decides the channel (urgent goes to WhatsApp or Telegram, everything else to the morning screen) and each of us can change it.
- [ ] CH-8 Outgoing messages carry one-tap buttons (Done, Not today, Snooze) where the channel allows, and a tap comes back in as a normal message.
- [ ] CH-9 The MCP server lets a Claude or ChatGPT client read today, the backlog and arrivals, and write captures, modes and dismissals. Nothing else. It cannot send messages.
- [ ] CH-10 Say something on one channel and every other channel shows it within two seconds.
- [ ] CH-11 Adapters hold no business logic. Delete one and every test outside it still passes.

## Automations

Saying "we're out of oat milk" is enough. It goes in the next online shop without either of us opening the supermarket site.

- [ ] AUT-1 **(gate)** Mention a shopping item anywhere and within ten minutes it is in our supermarket basket. The home screen shows it was added and which product was chosen.
- [ ] AUT-2 The shopping helper runs in its own sealed space with its own login to the supermarket. Passwords are kept in a locked store and never appear in messages or logs.
- [ ] AUT-3 If it cannot find an exact match it adds nothing and asks you one question with two or three options to tap.
- [ ] AUT-4 It can never check out, change the delivery slot, or remove something it did not add. These are blocked by permissions, not just by instructions.
- [ ] AUT-5 The day before delivery, it sends a summary of the basket and what it added since you last looked, with a link to change it.
- [ ] AUT-6 Every shopping run keeps a log and screenshots, which you can open from the message that started it.
- [ ] AUT-7 A second helper (booking the car's MOT, renewing a prescription) can be added later without changing anything else.

## Platform

One coordinator, one queue, one agent, one database for the house. The morning screen never needs the AI to read anything.

- [ ] PLT-1 **(gate)** Message in, then coordinator, then job queue, then agent, then tools. That is the only path. Nothing else can call the agent, including timers.
- [ ] PLT-2 Jobs are DBOS workflows backed by Postgres, so every step is checkpointed and a crashed worker resumes from the last completed step rather than starting over. There is no hand-written queue. The full history of a job (events, tool calls, tokens, cost) can be looked up by its ID.
- [ ] PLT-3 Everything about the house (calendar copy, backlog, rules, weather and daylight, parcels, modes, plans, dismissals) lives in Postgres with managed migrations. No fact about the house lives only in the AI's memory.
- [ ] PLT-4 A day's plan is one row: an ordered list of typed blocks, each with its reason. Every version is kept with the inputs that made it.
- [ ] PLT-5 The agent is built with Mastra. There is one agent definition for v1 with tools for the house database, calendar, lists app, weather, sunrise, parcels and sending messages. Adding a tool does not change the coordinator.
- [ ] PLT-6 The AI's memory of how we talk and what we dismissed lives in Hindsight. The coordinator pulls the relevant bits into each prompt, limited to that person and this house.
- [ ] PLT-7 Screenshots, documents and automation logs go to S3-style storage we run ourselves, encrypted, and are referenced from Postgres by key, never stored inside it.
- [ ] PLT-8 The whole system starts with one `docker compose up` on our own server. Backup and restore are written down and have been tried once.
- [ ] PLT-9 Which AI provider we use is a setting. Changing it changes no application code.
- [ ] PLT-10 Long tool calls (browsing the supermarket, research) run as child DBOS workflows that report back to the parent. The coordinator never waits on them, and a timer firing is a DBOS scheduled workflow, not a cron process.
- [ ] PLT-11 The app reads from a query layer and listens for changes. It never calls the agent directly.

## Privacy and safety

The app can only suggest. It cannot move, delete or spend. Personal information is only used when its owner has said yes.

- [ ] PRV-1 **(gate)** The app can only add suggestions and record whether we accepted or dismissed them. It cannot create, move or delete calendar events, rules or backlog items that a person wrote. This is enforced in code and tested.
- [ ] PRV-2 Chloe's health tracking is stored separately, only she can add to it, the app only uses it if she turns that on, and it is never mentioned unless she asks.
- [ ] PRV-3 The app only reads emails that look like order confirmations. It keeps the shop and the date, not the email.
- [ ] PRV-4 The app stores nothing about the kids beyond first names and nursery days. No photos, no health details.
- [ ] PRV-5 Messages are kept for 30 days to fix problems, and one setting turns that off completely.
- [ ] PRV-6 Nothing is reachable from the internet without a login.
- [ ] PRV-7 Each of us can download or delete everything about ourselves with one command.
- [ ] PRV-8 The app cannot spend money, book anything, or message anyone outside the four of us and the named babysitters.

## Quality and dev workflow

The building agent can pick up any open line, make it true, prove it, and ship it with its reasoning on record. We can tell whether the planner is getting better.

- [ ] QA-1 **(gate)** Every line in this doc is a Linear issue with the same ID in its title, in a project with a `verification` label. An issue is Done only when its evidence is attached.
- [ ] QA-2 Issues carry blocked-by links matching the **(gate)** lines, so an agent asking for "unblocked and unassigned" always gets a valid next task.
- [ ] QA-3 Each screen on the design canvas has a matching frame in [Paper](https://paper.design) built from a shared set of design tokens. The building agent reads it through Paper's MCP server to get real code, rather than copying a screenshot.
- [ ] QA-4 The repo has [Entire](https://docs.entire.io/guides/checkpoints/capture-checkpoints.md) switched on, so every commit an agent makes links to the session that produced it (prompts, transcript, tool activity). A commit without that link fails CI.
- [ ] QA-5 One pull request per Linear issue. The branch is named after the issue ID, the PR links the issue and the checkpoint, and merging closes the issue.
- [ ] QA-6 There is a set of at least 20 real days (what the planner was given, what it produced, what we accepted or dismissed). Any change to a prompt or tool is scored against it in CI.
- [ ] QA-7 Every reminder rule (PRO-1 to PRO-10) has a plain test. No rule is checked only by the AI eval.
- [ ] QA-8 A job's trace (events, tool calls, tokens, cost, time taken) can be seen in one place. Monthly AI spend is shown on a page.
- [ ] QA-9 A practice household exists with made-up people, calendar and supermarket account. Automations are proven there before they touch ours.
- [ ] QA-10 Once a week the app posts one message: what it suggested, what we accepted, what we dismissed, and what it cost.

## Learning

The app gets better at our house by noticing what we do and asking short questions at good moments. Its suggestions fit how we actually live, not a default.

- [ ] LRN-1 **(gate)** Every accept, dismiss, snooze, hand-over and Done is remembered along with the day, time, weather, mood of the day and who did it.
- [ ] LRN-2 For things we do regularly but never schedule (dark wash, towels, hoovering, watering plants) the app works out how often from when we mark them done, and shows it as a number you can change: "about every 5 days".
- [ ] LRN-3 When it does not know something yet, it asks one question on the morning screen that you can answer with one tap: "How often do you do a dark wash? 3 days / 5 days / weekly". At most one question a day for the whole house.
- [ ] LRN-4 It only asks about specific gaps (a chore with no rhythm, a job with no rough length, a sitter with no known free days). It never asks open questions, and never asks the same thing twice.
- [ ] LRN-5 It learns when suggestions land. If you accept washing suggestions in the morning and dismiss them in the evening, the evening ones stop within two weeks.
- [ ] LRN-6 It learns about each of us separately. A job Cal always dismisses and Chloe always accepts is offered to Chloe.
- [ ] LRN-7 Everything it has learned is shown on a Settings page as plain sentences: "Dark wash: every 5 days, usually Sunday". Delete a sentence and it forgets.
- [ ] LRN-8 What it learns only changes when it suggests things. It never turns into a deadline.
- [ ] LRN-9 Cal keeps a record of real days so changes to the learning can be checked against what actually happened.

## Wellbeing, light touch

The app notices when one of us has had too many hard days in a row and offers something small. It never judges, never nags, and goes quiet when told to.

- [ ] WB-1 **(gate)** The app keeps a simple "how heavy was today" score for each of us, worked out only from things it already knows: hours alone with the kids, work events, early starts, slow or sick days, how many things got done. It never reads mood from how we write.
- [ ] WB-2 After three heavy days in a row with no free time, it first suggests something to the *other* person: "Chloe's had three heavy days, could you take Saturday morning?". Only then does it say anything to the person who had the hard days.
- [ ] WB-3 What it suggests comes from a short list we write ourselves (a walk, an early night, cancelling something, a takeaway, calling a friend). It is offered, not prescribed, with no health talk.
- [ ] WB-4 On a heavy day, if the app sees you have a free hour, it leaves it free rather than filling it with backlog jobs.
- [ ] WB-5 These messages count towards your daily limit, happen at most twice a week, and one tap on "not helpful" stops them for a month.
- [ ] WB-6 Each of us can switch this off for ourselves, and can see exactly what went into the score.
- [ ] WB-7 Chloe's health tracking only counts towards her score if she turns that on, and the app never mentions it in what it says.
- [ ] WB-8 The app does not store or guess mood, sleep or any health condition. The only thing kept is the daily score and what it was made from.

## Code (Cal only)

Types come first and everything else depends on them. Each domain owns its own database and its own API. As many rules as possible are enforced by tools, not by instructions to the agent.

- [ ] CODE-1 **(gate)** A root-level `contracts` package holds every shared type and every enumerated value. Enumerated values are TypeScript `as const` objects, never Postgres enums and never string unions typed by hand. Nothing in `contracts` imports from anywhere else in the repo.
- [ ] CODE-2 Drizzle schemas import their column types and enumerated values from `contracts`, so the dependency direction is always contracts → schema → app, and a CI check (Fallow boundaries) fails any import that goes the other way.
- [ ] CODE-3 The front end imports the same `as const` objects from `contracts` for labels, options and validation. No value is spelled twice.
- [ ] CODE-4 Each domain (household, calendar, backlog, plans, parcels, learning, wellbeing, jobs) has its own Postgres database, its own Drizzle schema and its own migrations managed by drizzle-kit. No table is read across databases; domains talk through tRPC.
- [ ] CODE-5 Each domain exposes exactly one tRPC router, which is the only way any other code reads or writes that domain. The router's input and output types come from `contracts`.
- [ ] CODE-6 Every foreign key is declared twice in Drizzle: as a column reference on the table and as a `relations()` entry, so the query API can traverse it. A CI test fails if a key has no matching relation.
- [ ] CODE-7 oxlint runs on every PR with the strictest preset we can keep green, plus rules for: no `any`, no non-null assertion, no unused exports, exhaustive switch over `as const` values, no default exports, sorted imports.
- [ ] CODE-8 [Fallow](https://unpkg.com/fallow@3.35.0/README.md) runs on every PR via `fallow audit`: unused files, exports and dependencies, circular imports, duplication, and the architecture boundary rules from CODE-2 and CODE-4 are all configured in `.fallowrc.json` and any finding fails the PR.
- [ ] CODE-9 `AGENTS.md` is under 60 lines. It says how to pick a task, where types live, how to run the checks, and how to hand a PR over. Every rule that a tool can enforce is in the tool, not in the file.
- [ ] CODE-10 TypeScript runs in strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and `tsc --noEmit` passes on every PR.
- [ ] CODE-11 A single `pnpm check` runs tsc, oxlint, Fallow, drizzle-kit check and the tests; it is the only command CI runs and the only one the agent needs to know.

- [ ] CODE-12 **(gate)** All model calls go through the Vercel AI SDK. No provider SDK is imported directly anywhere else, and the provider is chosen by configuration (PLT-9).
- [ ] CODE-13 No timeout, token limit, retry cap, output cap, concurrency cap or any other limit is set on a model call, tool call or job unless its reason is written next to it as a comment citing best practice, a security control, or a stated requirement in this document. A limit with no reason is a lint failure (a custom oxlint rule flags `maxTokens`, `maxOutputTokens`, `timeout`, `maxRetries`, `AbortSignal.timeout` and similar without an adjacent `// limit:` comment).
- [ ] CODE-14 The reasons that count are listed in `contracts/limits.ts` with links: the OWASP Top 10 for LLM Applications (unbounded consumption, prompt injection, excessive agency), the OWASP API Security Top 10, a provider's documented hard limit, or a line in this document. A limit that cites nothing on the list is rejected in review.
- [ ] CODE-15 Where a limit is justified it is a named constant in `contracts/limits.ts` with its reason, never a literal at the call site, so there is exactly one place to see every constraint the system imposes.

## Feedback loop (Cal only)

The building agent finds out whether its change worked in seconds, and proves user journeys by using the app the way we will, not only by unit tests.

- [ ] FB-1 **(gate)** The agent can run the whole system locally with one command and see a change in the browser in under two seconds (Vite dev server with HMR; reason: agent iteration speed).
- [ ] FB-2 `pnpm check` (CODE-11) finishes in under four minutes on a clean checkout, measured in CI; anything slower is split into a fast default and a `pnpm check:full` (reason: agent iteration speed).
- [ ] FB-3 Every line in Morning glance, Capture, In the moment, Proactive nudges and Automations has an end-to-end test that drives the real app against the practice household (QA-9), written in Playwright and runnable headless in CI.
- [ ] FB-4 The building agent has computer use and a browser available in its sandbox, and its definition of done for a user-facing line is: run the e2e test, then perform the journey itself with computer use on the deployed preview, and attach the screenshots to the Linear issue as evidence (QA-1).
- [ ] FB-5 Every PR gets a deployed preview URL with its own practice household, so a journey can be checked by a person or an agent before merge.
- [ ] FB-6 Seeding the practice household (people, a week of calendar, twenty backlog items, three parcels, a supermarket basket) is one command and takes under ten seconds (reason: agent iteration speed).
- [ ] FB-7 Test failures print the failing verification ID and a one-line plain-language reason first, so an agent reading the log knows what is false before it reads the stack trace.

## Out of scope for v1

These are deliberately not true at v1 so the first build stays small.

- Multi-household or any user outside the four of us.
- Native iOS or Android apps; the PWA is the app.
- Apple Wallet parcel tracking (no API); email parsing covers it.
- Automated reading of Chloe's health app; a Shortcut or manual signal only.
- The agent choosing which supermarket products to substitute without asking.
- Any UI the agent generates beyond composing the fixed block set.
- A second agent; one agent definition until a verification above needs otherwise.
