# Canvas Pilot

Pilot a spatial canvas from the CLI — create canvases, generate images/text/video/agent responses, read results, recall past work, and manage nodes on [Flowith](https://flowith.net)'s shared canvas.

Your AI agent gets a live cursor on the canvas. It moves in real time — users see nodes appear and the tree grow.

## Install

```bash
npx skills add flowith-ai/canvas-pilot
```

## What It Does

- **Create** canvases and place nodes on a spatial workspace
- **Generate** images, text, video, and multi-step agent responses
- **Read** results back — images as markdown, text inline, video as links
- **Recall** past work across all canvases with semantic search
- **Batch** independent generations in parallel for speed

## Quick Start

```bash
# Create a canvas and generate an image
bun $S --bot claude-code create-canvas "Dog Artwork"
bun $S --bot claude-code set-mode image
bun $S --bot claude-code submit "a golden retriever in a wheat field" --wait

# Burst: many items at once
bun $S --bot claude-code submit-batch "golden retriever" "husky" "corgi" "poodle"
bun $S --bot claude-code read-db --full

# Recall past work
bun $S recall "cyberpunk logo" --type image
```

## Modes

| Mode | Use for |
|------|---------|
| `text` | Answers, writing, analysis |
| `image` | Visual generation |
| `video` | Video clips |
| `agent` / `neo` | Multi-step research, planning, complex deliverables |

## Requirements

- A [Flowith](https://flowith.net) account with an active session in the browser
- [Bun](https://bun.sh) runtime

## Documentation

Full command reference and usage patterns are in [SKILL.md](./SKILL.md).

## License

MIT
