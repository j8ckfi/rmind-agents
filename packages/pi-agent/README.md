# @open-agents/pi-agent

Wraps `@mariozechner/pi-coding-agent` so the rack can run coding-agent turns
backed by `@open-agents/sandbox` and route per-turn across OpenCode Go,
Codex OAuth, and Anthropic.

## Public surface

```ts
import { runAgentTurn } from "@open-agents/pi-agent";

const result = await runAgentTurn({
  taskId,
  sandbox,                                      // from connectSandbox(...)
  prompt: "fix the failing test in packages/x",
  modelSpec: { provider: "opencode-go", model: "glm-5.1" },
  history,                                      // prior assistant/user messages
  onEvent: (chunk) => writer.write(chunk),      // forwarded to the UI
  abortSignal: controller.signal,
});
```

The returned `AgentTurnResult` is a tagged union — either `{ ok: true,
finishReason, usage }` or `{ ok: false, code: "auth" | "model_not_found" |
"runtime", error }`.

## Configuration

Two files drive the model fleet:

- `models.json` — provider + model catalogue. Default path is
  `~/.pi/agent/models.json`; override with `PI_MODELS_PATH`. A starter copy
  lives at `templates/models.json` in this package.
- `auth.json` — OAuth tokens and runtime API key cache. Default path is
  `~/.pi/agent/auth.json`; override with `PI_AUTH_PATH`. API keys for
  OpenCode Go and Anthropic are read from env (`OPENCODE_GO_API_KEY`,
  `ANTHROPIC_API_KEY`) so they never need to land in this file.

## Initial OAuth setup (Codex)

OAuth requires an interactive browser handoff. Do this once over SSH from
your laptop:

```bash
ssh rack -L 8765:localhost:8765
pi auth login codex
# follow the printed URL in your laptop browser
```

`pi` writes refreshed tokens back to `auth.json`. Subsequent token refreshes
are automatic.

## Tool surface

`buildSandboxTools(sandbox)` returns the pi `ToolDefinition[]` covering
`read`, `write`, `edit`, `grep`, `glob`, `bash`, and `web_fetch`. Each one
proxies through the `Sandbox` interface — nothing reaches the host
filesystem. `web_fetch` runs in the agent process (not the container) so it
respects the rack's outbound network policy directly.

## Streaming

`runAgentTurn` subscribes to the pi session and translates `AgentSessionEvent`
into `UIMessageChunk` (`start`, `text`, `tool-call`, `tool-result`,
`tool-update`, `compaction`, `retry`, `finish`). The web app forwards these
chunks straight into the existing UI stream, so the React side does not need
to know which agent backend is running.
