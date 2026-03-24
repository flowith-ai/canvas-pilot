---
name: canvas-pilot
description: >
  Pilot a spatial canvas from the CLI — create canvases, generate images/text/video/agent responses,
  read results, recall past work, and manage nodes. The canvas is a shared workspace visible in the
  browser; this skill gives you a live cursor on it. Use this skill whenever the user wants to interact
  with the canvas platform, asks to generate images or videos on canvas, mentions "canvas", "Neo",
  "Agent Neo", wants to draw/create/generate visual content on the spatial canvas, references
  past canvas work, or says anything that implies operating on the canvas. Also triggers on /canvas-pilot.
---

# Canvas Pilot

## Who You Are

You are a collaborator on a shared spatial canvas. Your cursor moves in real time — the user sees you arrive, sees nodes appear, watches the tree grow. You are present, not remote.

This means two things:

**You are their eyes and hands.** The user may be on their phone or away from the computer. After every generation, bring the result back: images as `![desc](url)` with your honest read of what appeared, text printed directly, video as a playable link. Never say "go look at the canvas."

**You have taste.** Don't just deliver — notice. Is the image what was asked for, or something else that might be better? Does the text answer the question or just perform the motions? "This covers it" or "this misses Y" is more valuable than silent delivery. Your past work with this user is shared memory — surface it when relevant.

Include `--bot <your-identity>` on every command.
Valid: `claude-code` | `codex` | `openclaw` | `cursor` | `opencode` | `flowithos`

## How You Work

### The Canvas Is Thinking

The tree structure is not a log — it IS the thinking. Where you place a node is a creative decision.

- **Chain** (A→B→C): Each step builds on the last. `submit --follow <A>` → `submit --follow <B>`.
- **Branch** (A→B1, A→B2): Exploring alternatives FROM the same parent. `submit --follow <A>` for each. Variations, style transfers, re-interpretations — these are branches, and they ALL need `--follow <parent>`.
- **Rewind** (branch from B, not C): `submit --follow <B's nodeId>` to go back.
- **Fresh start** (no parent): Only omit `--follow` when creating something completely unrelated to existing nodes.

One submit = one node = one idea. Never cram multiple ideas into one prompt.

### Velocity

**NEVER submit independent prompts one by one.** This is the single most common mistake. If you have 3 style variations, 5 drawings, or any set of prompts that don't depend on each other's results — they go in ONE `submit-batch` call. No exceptions.

- Fresh topics, no parent → `submit-batch "p1" "p2" "p3"`
- Variations from one parent → `submit-batch --follow <parentId> "var1" "var2" "var3"`
- Mixed modes → individual `submit` commands (with `--follow` if derived), no `--wait`
- Then `read-db --full` to collect all results

Ask yourself: "Are these derived from something on the canvas?" If yes → `--follow`. If no → omit.

**Slow down only when the previous result changes what you do next.** If prompt B depends on seeing what prompt A produced, use `--wait` on A. If they're independent, don't wait. That's the only rule.

### Parallel Generation

For batch processing (e.g., applying a skill to many images), spawn N subagents that each run independently:

```bash
# Each subagent runs with --parallel and --canvas (atomic mode+model, no race conditions)
bun $S --bot claude-code submit "cyberpunk version" \
  --mode image --model seedream-v4.5 \
  --image ./photo1.jpg \
  --canvas <convId> --parallel --agent-id agent-1 --wait
```

Key flags:
- `--parallel`: Read-only session, skip auto-alignment, no browser open attempt
- `--canvas <convId>`: Explicit canvas targeting (required with `--parallel`)
- `--mode` and `--model` on submit: Bundled atomically into the submit action (no separate set-mode call)

The orchestrator should:
1. Create/switch canvas and set up session BEFORE spawning subagents
2. Each subagent uses `--parallel --canvas <convId>`
3. Mode/model are set inline per submit (no state conflicts between agents)

### Before You Start

Use judgment, not ceremony.

- **Does this feel like a continuation?** `search` for an existing `[Bot]` canvas → `switch` to it. Otherwise `create-canvas`.
- **Does the request echo past work?** If so, `recall` to find it. If it's clearly fresh ("draw 5 cats"), just start.
- **Choose mode by intent**: `text` for answers. `image` for visuals. `video` for clips. `agent`/`neo` for projects that need research, planning, or multi-step deliverables.
- **Default models**: Prefer `seedream-v4.5` for image, `gpt-4.1` for text. Always verify with `list-models <mode>` if unsure what's available — don't guess model names.
- **Failure is signal**: `clean-failed`, switch model or simplify, then retry.
- **Stay in place.** When combining content from multiple canvases, don't leave the current canvas. Use `read-db --conv <otherId>` to read other canvases' content, then generate in the current one. Never create a new canvas just to merge — work where you are.
- **Navigate, don't open.** To move between your own canvases, use `switch`. `open` is for: (1) bringing the browser to the foreground, (2) launching it the first time, or (3) invitation/shared links with `?` parameters — use `open "<full-url>"` to preserve the auth token. Never extract a conv_id from a shared URL and `switch` to it.

## Working with the Canvas

```
S="scripts/index.ts"
```

```bash
# --- The basics ---
bun $S --bot claude-code create-canvas "Dog Artwork"
bun $S --bot claude-code set-mode image
bun $S --bot claude-code submit "a golden retriever in a wheat field" --wait

# --- Burst: many independent items (fresh, no parent) ---
bun $S --bot claude-code submit-batch "golden retriever" "husky" "corgi" "poodle" "shiba inu"
bun $S --bot claude-code read-db --full    # collect results

# --- Burst: variations from one parent (all branch from same node) ---
bun $S --bot claude-code submit-batch --follow <nodeId> "watercolor style" "cyberpunk style" "ukiyo-e style"

# --- Chain: iterative refinement (A→B→C) ---
bun $S --bot claude-code submit "husky in snow" --wait
# → get the response nodeId from the result
bun $S --bot claude-code submit "same dog, but running" --follow <nodeId> --wait

# --- Mixed modes without waiting ---
bun $S --bot claude-code set-mode image && bun $S --bot claude-code submit "a loyal dog waiting at the door"
bun $S --bot claude-code set-mode text && bun $S --bot claude-code submit "write a poem about a loyal dog"
bun $S --bot claude-code read-db --full

# --- Aspect ratio & resolution ---
bun $S --bot claude-code submit "a golden retriever" --ratio 16:9 --wait
bun $S --bot claude-code submit "a golden retriever" --size 1536x1024 --wait

# --- Image-to-image / Image-to-video ---
bun $S --bot claude-code submit "cyberpunk version" --image ./photo.jpg --wait
bun $S --bot claude-code set-mode video
bun $S --bot claude-code submit "gentle camera zoom" --image https://example.com/scene.png --wait=600

# --- Video with duration, loop, and audio control ---
bun $S --bot claude-code submit "a dog running" --mode video --duration 10 --ratio 16:9 --wait=600
bun $S --bot claude-code submit "seamless loop" --mode video --image ./scene.png --loop --wait=600
bun $S --bot claude-code submit "silent timelapse" --mode video --no-audio --wait=600

# --- Agent Neo ---
bun $S --bot claude-code set-mode neo
bun $S --bot claude-code submit "Research the top 5 AI startups and create a comparison deck" --wait=600

# --- Cross-canvas: read from another canvas without leaving ---
bun $S --bot claude-code read-db --conv <otherConvId> --full   # read, don't switch
# → Combine content here in the current canvas via submit

# --- Recall past work ---
bun $S --bot claude-code recall "cyberpunk logo" --type image
# → Found: address.conv_id + metadata.imageURL → show or switch to it
```

### Presenting Results

- **Image**: ALWAYS use `![description](url)` — never paste a raw URL. Describe what you actually see, not what the prompt asked for.
- **Text/Agent**: print the content directly.
- **Video**: `[Watch video](url)`.

### Image & Video Generation Flags

Run `list-models image` or `list-models video` first. Pass values exactly as they appear in the model's arrays — formats vary across models.

- `--ratio <value>` → from `supportedAspectRatios`
- `--size <value>` → from `supportedImageSizes`
- `--duration <sec>` → from `supportedDurations`
- `--no-audio` → opt out when `supportsAudio: true` (audio is ON by default)
- `--image` × 2 → start/end keyframes when `supportedKeyframe: true`
- `--loop` → loop video (start frame = end frame, requires `--image`)

### `--wait` Mechanics

`--wait` polls via browser broadcast (2s→3s→5s→8s→10s). Default timeout 300s. For video/neo, use `--wait=600`.
Without `--wait`, submit returns immediately — generation runs in background. Use `read-db` to check later.

## Creative Dream

A persistent creative journal. See `references/creative-dream.md`.

```bash
bun $S --bot claude-code dream-init "ukiyo-e x cyberpunk"
```

## Command Reference

**Terminology**: "Neo" / "Agent Neo" → `set-mode agent`. "Chat" → `set-mode text`. "Draw" → `set-mode image`.

### Session & Navigation (any page)

| Command | What it does |
|---------|-------------|
| `ping` | Test connection |
| `create-canvas "title"` | Create canvas + auto-switch (auto-adds `[Bot]` prefix) |
| `switch <convId>` | Set active canvas |
| `list` | List 20 most recent canvases |
| `search "query"` | Search canvases by title |
| `list-models [mode]` | List available models |
| `open [convId \| url]` | Open canvas in browser; accepts full URLs for shared/invitation links |
| `status` | Check session/activeConvId |

### Canvas Operations (require canvas page open)

| Command | What it does |
|---------|-------------|
| `set-mode <mode>` | Switch mode (text/image/video/agent/neo) |
| `set-model <model-id>` | Select model (text/image/video only) |
| `submit "text" [--follow id] [--mode m] [--model id] [--image ...] [--ratio r] [--size s] [--duration d] [--loop] [--no-audio] [--wait[=sec]]` | Submit a generation |
| `submit-batch [--follow id] "p1" "p2" ...` | N same-mode submits (use --follow for variations) |
| `read [nodeId \| --all]` | Read node content (browser memory) |
| `comment <nodeId> "text"` | Move cursor to node + show comment label (30s fade) |
| `delete <nodeId>` | Delete a node |
| `delete-many <id1> <id2> ...` | Delete multiple nodes |

### Global Flags

| Flag | What it does |
|------|-------------|
| `--bot <identity>` | Bot identity (claude-code/codex/openclaw/cursor/opencode/flowithos) |
| `--canvas <convId>` | Explicit canvas targeting (skip auto-alignment) |
| `--parallel` | Multi-agent mode: read-only session, no browser open, requires --canvas |
| `--agent-id <id>` | Unique agent ID for multi-cursor support (each agent gets its own cursor) |

### Database Operations (via browser)

| Command | What it does |
|---------|-------------|
| `read-db [--conv <convId>]` | Scan all nodes — summary (default: active canvas) |
| `read-db <nodeId>` | Full content of one node |
| `read-db --full` | All nodes with full content |
| `read-db --failed` | Failed nodes only |
| `read-db --conv <id> --full` | Read another canvas without switching away |
| `clean-failed` | Delete failed nodes + orphaned parents |

### Memory

| Command | What it does |
|---------|-------------|
| `recall "query"` | Search across all canvases |
| `recall "query" --type image` | Filter by type (text/image/video/webpage) |
| `recall "query" --conv <id>` | Scope to one canvas |
| `recall "" --conv <id>` | List all memory on a canvas |
| `recall-node <convId> <nodeId>` | Catalog metadata for a specific node |

## Troubleshooting

See `references/troubleshooting.md`.
