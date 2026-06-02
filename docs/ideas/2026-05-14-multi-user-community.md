# Idea: multi-user habit-daemon as a community accountability product

**Captured:** 2026-05-14
**Status:** Idea / not yet planned. Real scope warnings below.

## The pitch (Max's words, paraphrased)

A public Discord community channel where 10+ friends all use the same
habit-daemon. They chat publicly, but the bot also calls people out
publicly when they miss tasks. Each user gets their OWN private habit
channel where they talk to Claude like Max does today. Wins are public —
everyone sees each other's ✓s.

This is real. Max doesn't know anyone who doesn't need a habit tracker.
The accountability layer + the community + the public wins is a coherent
product concept.

## What today's habit-daemon already gives you

The accountability-partner Claude persona, the Concept2/Garmin sensor
auto-completion, the escalation engine, the #wins ledger, the
chat-with-Claude-anytime flow — these all work and they're the hard
parts. Everything below is plumbing on top.

## Honest scope assessment

This goes from a single-user Mac daemon to a multi-tenant cloud product.
That's NOT a weekend. Realistic estimate: 4-8 weeks of focused work
for a usable MVP with 10 friends. Some of it is straightforward (DB
schema changes); some of it is hard (auth, privacy, costs at scale).

## Pieces that need to be built

### 1. User identity throughout the data model

Everything in the daemon today assumes one user (Max). To support N
users, every habit-scoped table needs a `user_id` foreign key:

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,        -- UUID
  display_name    TEXT NOT NULL,
  discord_user_id TEXT NOT NULL UNIQUE,    -- for inbound message routing
  created_iso     TEXT NOT NULL,
  archived_at     TEXT
);

-- Then ALTER:
ALTER TABLE habits          ADD COLUMN user_id TEXT NOT NULL REFERENCES users(id);
ALTER TABLE habit_runs      ADD COLUMN user_id TEXT NOT NULL REFERENCES users(id);
ALTER TABLE sensor_signals  ADD COLUMN user_id TEXT NOT NULL REFERENCES users(id);
ALTER TABLE miss_reasons    ADD COLUMN user_id TEXT NOT NULL REFERENCES users(id);
ALTER TABLE session_events  ADD COLUMN user_id TEXT;       -- nullable for system events
-- + journal_entries, proof_stages, etc.
```

Then every query in every orchestrator gets a `WHERE user_id = ?`
predicate added. The reconciler, evaluate-stage-b, habit-checkin,
handle-proof-message, handle-user-message, every API endpoint — all
become user-scoped.

This is mechanical but it touches almost every file. ~10-15 hours.

### 2. Discord listener: identify which user is talking

Today the listener doesn't care WHO sent a message — there's only one
user. With multiple users, every messageCreate maps `msg.author.id`
(Discord user ID) → users.discord_user_id → users.id → load THAT user's
habits + runs + chat context.

If a Discord user isn't in the `users` table, the bot either:
- Ignores them (safer)
- Replies "Hey, you're not registered. DM the bot or use the web UI
  to sign up."

### 3. Per-user Claude context

The system prompt today says "You are Max's accountability partner".
Becomes: "You are {user.display_name}'s accountability partner" with
THEIR data only embedded in the JSON context block. No cross-user
leakage — `loadChatContext` MUST filter every query by `user_id`.

Privacy is non-negotiable here. User A asks Claude "what habits is User B
working on?" → Claude must have no visibility into User B's data and
should decline cleanly. This is enforced at the DATA layer (loader
filters), not the prompt layer (which can be jailbroken).

### 4. Channel topology

Several models. Each has tradeoffs:

**Model A — One server, per-user threads:**
- One Discord server hosts the community.
- `#community` channel for shared chat.
- `#wins` shows everyone's completions (with @-mentions).
- Each user gets a PRIVATE THREAD in `#personal-habits` (Discord threads
  are private to invited members). Their own coaching happens there.
- Pros: minimal Discord setup. One bot, one server, easy to onboard friends.
- Cons: threads have UX quirks; users may want true channel privacy.

**Model B — One server, per-user channel with permission overrides:**
- Bot creates a private channel per user (`#max-habits`, `#alice-habits`).
- Channel permissions: only the user + bot can read/write.
- `#community` and `#wins` are public.
- Pros: clean isolation, each user gets a real channel.
- Cons: bot needs Manage Channels permission. Channel count grows
  linearly with users.

**Model C — Each user has their own Discord server, bot joins via invite link:**
- Highest isolation. Each user owns their server.
- A shared "community" server bridges all users for the public channel
  + wins.
- Pros: feels like a real per-user product.
- Cons: complex invite flow. Two Discord setups per user. Bot has to
  bridge messages between servers — moderation nightmare.

For a friends-and-family MVP, **Model A or B** is the answer.
Model A is faster to build.

### 5. Public callouts

The fun/risky part. When a user misses a habit (status flips to missed
at L5), the bot posts in `#community`:

```
@alice missed Morning Row today. Day 3 of a slump.
```

Design questions:
- **Opt-in or default?** Public callouts must be opt-in. Some friends
  will hate this. Add a `users.public_callouts_enabled` flag.
- **How harsh?** "Missed Morning Row" is factual. "@alice keeps making
  excuses, here's her streak of misses" crosses into shaming. Tune
  carefully. Probably: state the fact, no commentary.
- **Recovery acknowledgment?** When @alice DOES complete her habit
  after a slump, the bot calls THAT out too. Balance the criticism
  with celebration.
- **Streak shaming guardrail:** Don't pile on. If alice missed 3 days
  in a row, the bot says ONE thing in `#community` ("Day 3"), not three
  separate posts.

### 6. Per-user sensor auth

This is where things get painful:
- Concept2 OAuth: each user runs `bin/concept2-auth` to seed tokens.
- Garmin login: each user runs `garmin_fetch.py --login` interactively.
- Where do per-user tokens live? Need a `user_credentials` table or
  per-user files keyed by user_id.

For friends who don't have a PM5 or Garmin, **default to photo-only
proof**. Most habits can be photo-verified via the vision dispatch we
already have. Sensor-based habits are an upgrade, not a requirement.

### 7. Hosting & cost

Today the daemon runs on Max's Mac via launchd. For 10 friends in
different timezones with cron jobs firing at 9am their time, you need:

- **Always-on host:** Mac (current), or migrate to cloud (Fly.io,
  Railway, a VPS). Cloud avoids Mac-asleep gotchas.
- **Cost model:**
  - Compute: ~$5-20/month for a small VPS.
  - Claude API: ~50 dispatches/user/day × $0.01 = $0.50/user/day =
    $15/user/month. With 10 users: $150/month.
  - Discord: free.
  - Total back-of-napkin: $200/month for 10 users. $20/user/month if
    you pass cost through.
- **Pricing model:** free, paid, donation? If free, Max eats the cost.
  If paid, need Stripe + a checkout flow. If donation, awkward.

### 8. Onboarding flow

Today Max manually configured his habits via SQL. For friends:

- Web UI for habit CRUD (the chat-and-web-ui plan's Phase 5).
- Discord OAuth or invite-link flow to map Discord user → habit-daemon user.
- Default habits template ("morning row / strength / wind-down" or
  similar) the user can customize.
- Onboarding wizard: pick habits → set cadence → connect sensors
  (optional) → confirm.

### 9. Privacy + abuse + edge cases

- A user wants their data DELETED → need a real delete flow.
- A user wants to LEAVE → archive their data, keep them out of public
  callouts.
- One user trash-talks another in `#community` → moderation
  (manual, or chatops via the bot).
- A user reveals private info in `#community` thinking it was their
  private channel → Discord-side mitigation (clear channel labeling,
  cooldown UI cues).
- Eventually: GDPR-style data-export and right-to-be-forgotten.

## Smallest viable MVP

If you want to test the idea with 2-3 friends before going all-in:

1. **Skip sensors.** Photo-only proof for everyone except Max.
2. **One Discord server, Model A (threads).** Public `#community` and
   `#wins`. Per-user private thread for coaching.
3. **No public callouts yet.** Add after the basic flow is proven.
4. **Manual habit setup.** Friends DM Max their habits, Max adds them
   via SQL. Defer the web UI.
5. **Run on Max's Mac for now.** Migrate to cloud when it's working.
6. **Free for the test cohort.** Charge later if it works.

This cuts the MVP from 4-8 weeks to maybe 2 weeks. Real schema work
(user_id everywhere) is the long pole; the rest can be built
incrementally as friends ask for it.

## Why this is good

- The accountability-partner Claude is genuinely valuable. Max already
  proved it works for him. Friends seeing this will want it.
- Community + accountability is a known winning formula (think Beeminder,
  Stickk, Habitica). The Claude layer is what's new.
- Public wins create positive social pressure. Some people respond
  well to "everyone saw me check in 5 days in a row."

## Why this is risky

- **Scope.** This is a real product. Don't underestimate. 4-8 weeks
  minimum.
- **Cost.** Claude API costs scale linearly with users + their message
  volume. Need a billing model BEFORE inviting 10 friends.
- **Privacy.** Multi-tenant data isolation is non-negotiable. Every
  query, every prompt, every export needs user-scoping enforced at the
  data layer. One bug here and someone sees someone else's data.
- **Public shaming.** Easy to design badly. Easy to embarrass a friend
  who's going through real stuff. Default to opt-in, conservative
  framing, recoverable.
- **Hosting.** Mac-as-server is fine for one user. Not fine when
  Alice in Tokyo needs the bot at 9am her time and Max's Mac is asleep.
- **Support.** If Bob's bot stops working, who fixes it? Max owns the
  whole stack today.

## Two-question decision matrix

If Max wants to pursue this:

1. **Build for 2-3 friends first, or 10?**
   - 2-3: MVP scope above. Learn what people actually want. 2 weeks.
   - 10: Higher stakes, need real billing/hosting. 6-8 weeks.

2. **Free or paid?**
   - Free: Max pays $150-300/mo for compute + Claude. Caps at ~10
     users before it hurts.
   - Paid: Need Stripe + a real billing/cancel flow. Adds 1-2 weeks
     but makes the project sustainable.

## When ready to plan

Use `/superpowers:brainstorming` against this doc to pressure-test the
design, then `/superpowers:writing-plans` to author an execution plan.
This document captures the IDEA; the plan captures the EXECUTION.

## Open the conversation with friends first

Before building anything: tell 2-3 friends what you're imagining. Ask
which features they'd actually use. Specifically:
- Would they want public callouts? On by default, or opt-in?
- Would they pay for it? How much?
- What habits do they actually want to track?
- Are they on Discord already?

You'll learn more from 30 minutes of conversation than from 30 hours
of coding.
