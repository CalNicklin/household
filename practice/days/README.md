# Recorded days (LRN-9, QA-6)

One JSON file per day, named `YYYY-MM-DD.json`, validated by `zRecordedDay` in `server/learning/replay.ts`:

- `date`: the local date.
- `inputs`: what the planner was given, meaning the calendar (`title`, `start`, `end`), a one-line weather summary and the day's mode.
- `blocks`: what the planner produced (`id`, `type`, `title`, `reason`), in order.
- `responses`: what we did with it: `ref`, `subject`, `action` (done, not-today, accept, snooze, hand-over and so on), `person`, `at`, `dayPart`, `weekday`.

Export a day from the running house with:

```bash
node scripts/record-day.ts 2026-11-02 practice/days
```

`replayDays(dir)` replays learning over the days in order, with each day seeing only the days before it. It reports three numbers:

- dismissed suggestions it would now hold back;
- accepted suggestions it would wrongly hold back;
- dismissals it would still miss.

There are no recorded days in this folder yet; the test generates its own synthetic ones. Real days have to come from the real house: run the export on our own server each evening and commit the files here. They contain the plan and the taps, never message text.
