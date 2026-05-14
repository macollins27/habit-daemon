# Idea: #journal channel + persistent thought store

**Captured:** 2026-05-14
**Status:** Idea / not yet planned. No implementation work started.

## The problem this solves

Today, Max's ideas, tasks, and thinking live scattered across:
- 500+ claude.ai conversations (named by first message → not searchable by topic)
- ChatGPT history (same problem)
- Notes app entries
- Random Discord messages
- His own head

None of it categorizes itself by idea/theme. Nothing surfaces an old thought
when a new related one comes up. Stuff he wanted to do six months ago is
functionally lost unless he happens to remember it exists.

He doesn't want yet ANOTHER inbox. He wants the daemon to be the
single durable home for ideas — searchable, themed, surfaced back to him
when relevant.

## The shape (rough)

A new active channel `#journal` in Discord. Same single-channel mode as
`#habits`, but routes to a new orchestrator instead of habit-checkin/proof.

When Max sends a message in `#journal`:
- The daemon dispatches Claude with a "journal curator" system prompt
- Claude reads the message + recent journal context + searches the
  journal store for related entries by theme/keyword
- Claude either:
  - **Captures a new entry** — stores the message as a journal_entry,
    tags it with themes/projects, links related prior entries
  - **Surfaces relevant past entries** — "this connects to that idea
    you had about X 3 weeks ago, want to expand it?"
  - **Asks clarifying questions** to make the entry searchable
- Optional reminders: "you said you'd revisit this in 2 weeks" →
  scheduled surface-back

## Database shape (sketch)

```sql
CREATE TABLE journal_entries (
  id              TEXT PRIMARY KEY,        -- UUID
  created_iso     TEXT NOT NULL,
  source          TEXT NOT NULL,           -- 'discord' | 'web' | 'cli'
  channel_id      TEXT,                    -- nullable for non-discord sources
  text            TEXT NOT NULL,           -- the raw message
  summary         TEXT,                    -- model-generated 1-line summary
  themes_json     TEXT,                    -- ["productivity", "habit-daemon", ...]
  status          TEXT NOT NULL CHECK (status IN ('open','closed','archived')),
  remind_at       INTEGER,                 -- epoch ms; nullable
  parent_entry_id TEXT REFERENCES journal_entries(id),  -- nullable; threading
  embedding_blob  BLOB                     -- nullable; for semantic search later
);

CREATE INDEX idx_journal_entries_created ON journal_entries(created_iso DESC);
CREATE INDEX idx_journal_entries_remind  ON journal_entries(remind_at) WHERE remind_at IS NOT NULL;
```

`themes_json` is the cheap categorization (model assigns tags). `embedding_blob`
is the better long-term categorization (semantic similarity), but punt on
that until V2.

## Surfacing-back mechanics

Two paths:
1. **Pull**: Max says "what was I thinking about productivity last month?"
   → Claude searches journal_entries WHERE themes contains 'productivity'
   AND created_iso >= '<30 days ago>' → summarizes and surfaces.
2. **Push**: Daily/weekly scheduled job that looks for `remind_at <= now`
   entries and posts them in #journal. ("Two weeks ago you wanted to think
   about X. Still relevant?")

For push, reuse the existing scheduler/cron infrastructure. New verb:
`surface-journal-reminders`, runs every morning at e.g. 8am local.

## Integration with existing chat

The `#journal` channel uses the same listener fall-through model that
`#habits` does today, but routes to a new orchestrator `handle-journal-message.ts`
instead of `handle-user-message.ts` (the current chat). Or: make it one
orchestrator with channel-based routing inside.

Could ALSO let Max @-mention an idea from `#habits` chat ("remember this for
the journal") and the bot auto-files it as a journal entry. Bonus feature.

## Open design questions

1. **Themes**: model-assigned every entry, or only at search time?
   - Per-entry tagging means cheap query, more tokens up front.
   - Search-time tagging is lazy, more flexible, lossier on retrieval.
   - Probably: lightweight model-assigned themes at capture + semantic
     embeddings for the heavy lift.

2. **Reminders**: who decides `remind_at`?
   - Max ("remind me about this in 2 weeks") → set at capture.
   - Claude infers ("this sounds like a follow-up worth tracking") →
     proactive but easy to over-suggest.
   - Probably: Max-set explicitly, Claude can suggest but doesn't impose.

3. **Web UI surface**: does the Phase 5 (chat-and-web-ui plan) web UI
   get a Journal tab? Probably yes once the data exists.

4. **Migration from existing chat**: should we backfill journal_entries
   from existing `user_message_received` events? Probably not — different
   intent. Journal is opt-in capture, chat is conversational.

5. **Privacy / search across sources**: importing 500+ claude.ai
   conversations is out of scope for V1 (no clean API). Future: an
   uploader that ingests claude.ai exports + categorizes.

## Effort estimate

Rough: 8-15 hours of focused implementation. Comparable to a single phase
of the original remediation plan.

- Migration 007 (journal_entries schema): 1 hour
- handle-journal-message orchestrator + tests: 4 hours
- Journal-curator system prompt: 1 hour
- Surface-back cron verb: 2 hours
- Listener routing (#journal → journal orchestrator): 1 hour
- Web UI integration (later phase): 4+ hours

## Why this is good

- Solves a real pain point Max has TODAY (lost ideas).
- Reuses everything we just built: listener fall-through, Claude
  dispatch via API key, session_events audit trail, scheduler/cron.
- One more channel in the same Discord server — natural extension,
  not a new product surface.
- Compounds with the chat work just shipped: Claude already knows him.
  Journal context strengthens that further.

## Why this is risky

- Scope creep magnet. "What if it could also..." every feature.
  Keep V1 ruthlessly bounded: capture + tag + manual recall + simple
  remind_at. Nothing else.
- Embeddings (semantic search) need careful storage and a model call
  per entry. Costs add up at 100s of entries.
- Could become a place to dump anxieties instead of acting on them.
  The accountability-partner framing still applies — bot should push
  back when an entry sounds like avoidance, not just file it.

## Open the canonical plan when ready

When Max is ready to build this, use `/superpowers:writing-plans` or
the brainstorming skill against this doc as the seed. This doc captures
the IDEA; the plan captures the EXECUTION.
