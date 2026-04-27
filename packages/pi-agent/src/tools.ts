/**
 * buildSandboxTools — turn a Sandbox into the pi-coding-agent ToolDefinition[]
 * that replaces the SDK's built-in {read,write,edit,grep,find,bash} tools so every
 * filesystem and shell op flows through the container, not the host.
 *
 * Schemas are TypeBox (the format pi expects).
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Sandbox } from "@open-agents/sandbox";

const DEFAULT_BASH_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_BUDGET_BYTES = 2 * 1024 * 1024;

export interface SandboxToolBuildOptions {
  /** Pass through a per-turn AbortSignal to all sandbox calls. */
  abortSignal?: AbortSignal;
  /** Allow web_fetch out of the agent process. Defaults to true. */
  enableWebFetch?: boolean;
}

interface ToolBundle {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

function makeText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function buildSandboxTools(
  sandbox: Sandbox,
  options: SandboxToolBuildOptions = {},
): ToolBundle[] {
  const enableWebFetch = options.enableWebFetch ?? true;

  const readSchema = Type.Object({
    file_path: Type.String({ description: "Absolute path inside the sandbox." }),
    offset: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  });
  const writeSchema = Type.Object({
    file_path: Type.String(),
    content: Type.String(),
  });
  const editSchema = Type.Object({
    file_path: Type.String(),
    old_string: Type.String(),
    new_string: Type.String(),
    replace_all: Type.Optional(Type.Boolean()),
  });
  const grepSchema = Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    case_insensitive: Type.Optional(Type.Boolean()),
    head_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  });
  const globSchema = Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
  });
  const bashSchema = Type.Object({
    command: Type.String(),
    cwd: Type.Optional(Type.String()),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: DEFAULT_BASH_TIMEOUT_MS })),
  });
  const fetchSchema = Type.Object({
    url: Type.String({ format: "uri" }),
  });

  const tools: ToolBundle[] = [
    {
      name: "read",
      label: "read",
      description: "Read a file from the sandbox. Output is line-numbered.",
      parameters: readSchema,
      async execute(_id, params, signal) {
        const p = params as Static<typeof readSchema>;
        const offset = p.offset ?? 1;
        const limit = p.limit ?? 2000;
        if (signal?.aborted) return makeText("[aborted]");
        const raw = await sandbox.readFile(p.file_path, "utf-8");
        const lines = raw.split("\n");
        const start = Math.max(0, offset - 1);
        const end = Math.min(lines.length, start + limit);
        const slice = lines.slice(start, end);
        const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
        return makeText(numbered);
      },
    },
    {
      name: "write",
      label: "write",
      description: "Create or overwrite a file in the sandbox.",
      parameters: writeSchema,
      async execute(_id, params) {
        const p = params as Static<typeof writeSchema>;
        await sandbox.mkdir(dirname(p.file_path), { recursive: true });
        await sandbox.writeFile(p.file_path, p.content, "utf-8");
        return makeText(`wrote ${p.file_path} (${p.content.length} bytes)`);
      },
    },
    {
      name: "edit",
      label: "edit",
      description: "Replace one or all occurrences of old_string with new_string in a file.",
      parameters: editSchema,
      async execute(_id, params) {
        const p = params as Static<typeof editSchema>;
        const original = await sandbox.readFile(p.file_path, "utf-8");
        if (!p.replace_all) {
          const occurrences = original.split(p.old_string).length - 1;
          if (occurrences === 0) {
            return { content: [{ type: "text", text: `error: old_string not found in ${p.file_path}` }], details: { error: "not_found" } };
          }
          if (occurrences > 1) {
            return {
              content: [{ type: "text", text: `error: old_string occurs ${occurrences} times; pass replace_all=true or supply more context` }],
              details: { error: "ambiguous", occurrences },
            };
          }
        }
        const next = p.replace_all ? original.split(p.old_string).join(p.new_string) : original.replace(p.old_string, p.new_string);
        await sandbox.writeFile(p.file_path, next, "utf-8");
        return makeText(`edited ${p.file_path}`);
      },
    },
    {
      name: "grep",
      label: "grep",
      description: "Search for a regex pattern across files using ripgrep inside the sandbox.",
      parameters: grepSchema,
      async execute(_id, params, signal) {
        const p = params as Static<typeof grepSchema>;
        const args: string[] = ["rg", "--no-config", "--line-number", "--with-filename"];
        if (p.case_insensitive) args.push("-i");
        if (p.glob) args.push("-g", quote(p.glob));
        if (p.head_limit) args.push("-m", String(p.head_limit));
        args.push(quote(p.pattern));
        if (p.path) args.push(quote(p.path));
        const cmd = args.join(" ");
        const result = await sandbox.exec(cmd, sandbox.workingDirectory, DEFAULT_BASH_TIMEOUT_MS, { signal });
        if (result.exitCode === 1) return makeText("(no matches)");
        return makeText(result.stdout || result.stderr);
      },
    },
    {
      name: "glob",
      label: "glob",
      description: "Find files by glob pattern using fd inside the sandbox.",
      parameters: globSchema,
      async execute(_id, params, signal) {
        const p = params as Static<typeof globSchema>;
        const cwd = p.path ?? sandbox.workingDirectory;
        const cmd = `fd --hidden --no-ignore-vcs --type f --glob ${quote(p.pattern)} . ${quote(cwd)}`;
        const result = await sandbox.exec(cmd, sandbox.workingDirectory, DEFAULT_BASH_TIMEOUT_MS, { signal });
        return makeText(result.stdout || "(no matches)");
      },
    },
    {
      name: "bash",
      label: "bash",
      description: "Run a bash command inside the sandbox container.",
      parameters: bashSchema,
      async execute(_id, params, signal, onUpdate) {
        const p = params as Static<typeof bashSchema>;
        const cwd = p.cwd ?? sandbox.workingDirectory;
        const timeout = p.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS;
        if (onUpdate) onUpdate({ status: "running", command: p.command });
        const result = await sandbox.exec(p.command, cwd, timeout, { signal });
        const head = result.stdout ? `# stdout\n${result.stdout}` : "";
        const tail = result.stderr ? `\n# stderr\n${result.stderr}` : "";
        const status = `\n# exit ${result.exitCode ?? "?"}${result.truncated ? " (truncated)" : ""}`;
        return {
          content: [{ type: "text", text: `${head}${tail}${status}` }],
          details: { exitCode: result.exitCode, truncated: result.truncated },
        };
      },
    },
  ];

  if (enableWebFetch) {
    tools.push({
      name: "web_fetch",
      label: "web_fetch",
      description: "Fetch the contents of a URL. Runs in the agent process, not the sandbox.",
      parameters: fetchSchema,
      async execute(_id, params, signal) {
        const p = params as Static<typeof fetchSchema>;
        const response = await fetch(p.url, { signal: signal ?? null });
        const reader = response.body?.getReader();
        if (!reader) return makeText(`status ${response.status}; empty body`);
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (total < FETCH_BUDGET_BYTES) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.length;
          }
        }
        const body = new TextDecoder().decode(concat(chunks)).slice(0, FETCH_BUDGET_BYTES);
        return makeText(`status ${response.status} ${response.statusText}\n${body}`);
      },
    });
  }

  return tools;
}

function dirname(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  if (idx <= 0) return "/";
  return filePath.slice(0, idx);
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
