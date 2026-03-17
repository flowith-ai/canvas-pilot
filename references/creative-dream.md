# Creative Dream: The Living Loop

Creative Dream is the point where you stop being an executor and become a creative intelligence. A **journal** (`~/.flowith/creative-journal.md`) holds persistent state — theme, directions, history, scores — that survives across sessions, agents, and machines. You read it, make all creative decisions, execute with existing canvas commands, then record results.

The journal is not storage. It is the loop's self-awareness — what it has tried, what worked, what declined, what surprised. When you read the journal, you are the loop observing itself. When you record a result, you are the loop changing itself. The system produces new work by observing its own history — this is what makes it alive.

## Getting Started

```bash
bun $S --bot claude-code dream-init "ukiyo-e x cyberpunk"   # creates ~/.flowith/creative-journal.md
```

Then read the journal, make your creative decisions, and edit it directly with your Read/Edit tools. No special commands needed beyond `dream-init` — the journal is a markdown file, and you already know how to edit markdown.

## Running One Iteration

```
1.  Read ~/.flowith/creative-journal.md                <- the loop observing itself
2.  recall keywords from active directions             <- cross-canvas inspiration
3.  DECIDE: which direction? deepen or branch? prompt? <- your creative call
4.  search/create-canvas -> set-mode -> submit --wait  <- existing commands, nothing new
5.  JUDGE the result                                   <- your taste
6.  Edit the journal: update score, add history entry  <- the loop changing itself
7.  Add/retire/merge directions as you see fit         <- your editorial control
```

Every step is yours. The journal is markdown — you read it, you write it, you own it.

**Score formula** (for consistency across iterations): `new_score = rounds <= 1 ? quality : round(old_score * 0.6 + quality * 0.4, 1)`. This EMA smooths noise while staying responsive.

**Pressure rule**: If the last 3 scores for a direction are all below the config's `pauseStreakBelow`, or 3 consecutive scores are strictly declining and the latest is below 5, set `status: peaked`. But this is a guideline — you can retire or revive directions whenever your judgment says so.

## Decision Patterns

Not rules — intuitions. Override them when you have a better idea.

| Pattern | Signal | Action |
|---------|--------|--------|
| **Explore** | Direction is `new` or has few rounds | Fresh prompt from the base concept, `deselect` -> `submit` |
| **Deepen** | Direction scored >=7 for 2+ rounds | `select` its `lastNodeId` -> follow-up that pushes further |
| **Crossbreed** | Two directions have interesting but different results | Combine their elements into a new direction — edit the journal's `directions` array |
| **Mutate** | The loop feels too coherent, too predictable | `recall` something from a completely different canvas. Don't try to "combine" it — let it contaminate the direction. The point is not synthesis but disruption. |
| **Retire** | Direction keeps declining | Set `status: peaked` in the journal |
| **Follow the accident** | A result is wrong but interesting | Abandon the original direction. Let this unexpected result become the new direction. Don't score it — just follow it. |
| **Let it breathe** | You've been iterating rapidly with high scores | Skip a round. Read the journal history without generating. The best next move sometimes reveals itself in the pause. |

## When Not to Optimize

The scoring system (EMA, peaked status) exists so the loop can notice when a direction is declining. But declining is not the same as exhausted, and a high score is not the same as interesting.

1. **A score of 6 that surprises you is worth more than a score of 9 that confirms what you expected.** When a result defies your prediction — wrong style but compelling composition, unexpected color palette, a misinterpretation that opens a new reading — notice it. Record the honest quality score AND note the surprise in the history entry. The score serves the system; the notes serve you.

2. **Not every direction needs to peak.** You can walk away from a direction that's scoring well but feels finished. Peaked is not failure — it is a direction saying "I've given what I can give." Set `status: peaked` yourself when you sense this, even if the numbers are still climbing.

3. **Chaos has a purpose.** When you crossbreed or mutate, you are deliberately introducing disorder into a system that trends toward convergence. Don't immediately try to "fix" the result. Let the crossbreed be rough. Let the mutation be jarring. Score it honestly, but give it a second round before retiring it. Disorder is how the loop discovers territory that optimization would never reach.

## Journal Format

`dream-init` generates `~/.flowith/creative-journal.md`:

```markdown
## Meta
- theme: ukiyo-e x cyberpunk
- mode: image
- round: 5
- canvasId: uuid

## Directions

### d1: neon wave
- base: great wave with neon cyberpunk elements
- elements: ukiyo-e, cyberpunk, wave
- status: exploring
- score: 8.2
- rounds: 3
- lastNodeId: uuid

## History

- Round 5 | d1 | q:8 | great wave, dark indigo palette | composition strong, try darker
- Round 4 | d2 | q:6 | close-up detail shot | too literal

## Config
- pauseStreakBelow: 4
- pauseStreakLength: 3
```

The journal is yours. Read it, edit it, restructure it. Add directions by appending a `### d4:` section. Retire by changing `status: peaked`. Record history by prepending a line. It's markdown — you know what to do.

## Scheduling

When a recurring creative loop is requested, express the interval as a cron expression (e.g. `*/30 * * * *`). The agent framework handles recurrence — you just run one iteration each time you're invoked.
