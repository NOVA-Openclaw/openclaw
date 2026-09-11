/**
 * Reproduces nova-openclaw#165: the memory-flush write wrapper appends content
 * unconditionally, with no content-level idempotency check.
 *
 * The flush turn runs with an empty transcript prompt, so the model reconstructs
 * the day's log from its context window and emits it via `write`. Because the
 * wrapper coerces every `write` into an append, each successive flush in a
 * session re-appends the whole accumulated file. Corruption is therefore
 * CUMULATIVE within a session (2 headers -> 3 -> ...), not a one-shot
 * double-write.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const RELATIVE_PATH = "memory/2026-09-11.md";

function createWriteTool() {
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: "unused" }],
  }));
  return {
    name: "write",
    description: "Write content to a file.",
    inputSchema: { type: "object", properties: {} },
    execute,
  } as unknown as AnyAgentTool;
}

async function runWrite(tool: AnyAgentTool, root: string, content: string) {
  return tool.execute(
    "call-1",
    { path: path.join(root, RELATIVE_PATH), content },
    undefined as unknown as AbortSignal,
    () => {},
  );
}

describe("memory-flush append-only write (nova-openclaw#165)", () => {
  let root: string;
  let absolutePath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "flush-dupe-"));
    absolutePath = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("re-appends an identical daily-log body instead of deduplicating it", async () => {
    const body = ["# 2026-09-11", "", "- 07:11 workflow run #821 completed", ""].join("\n");
    await fs.writeFile(absolutePath, body, "utf-8");

    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(createWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });

    // Second flush in the same session re-emits the same body.
    await runWrite(wrapped, root, body);

    const after = await fs.readFile(absolutePath, "utf-8");
    const headers = after.match(/^# 2026-09-11$/gm) ?? [];

    // Documents current (defective) behaviour: the duplicate is appended verbatim.
    expect(headers).toHaveLength(2);
  });

  it("compounds across successive flushes, growing the file monotonically", async () => {
    const body = ["# 2026-09-11", "", "- 07:11 workflow run #821 completed"].join("\n");
    await fs.writeFile(absolutePath, body, "utf-8");

    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(createWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });

    // Three flushes, each re-emitting the whole accumulated file (observed shape
    // in the 2026-08-31 / 2026-09-01 triple-flush incidents).
    for (let i = 0; i < 3; i += 1) {
      const current = await fs.readFile(absolutePath, "utf-8");
      await runWrite(wrapped, root, current);
    }

    const after = await fs.readFile(absolutePath, "utf-8");
    const headers = after.match(/^# 2026-09-11$/gm) ?? [];

    // 1 -> 2 -> 4 -> 8: cumulative, not a single duplicate pair.
    expect(headers.length).toBeGreaterThan(2);
  });

  it("never consults existing content, so it cannot detect a repeated generated block", async () => {
    const generated = [
      "<!-- BEGIN GENERATED DAILY LOG — generated_at: 2026-09-11T12:00:01.895262Z -->",
      "## System summary (auto-generated)",
      "<!-- END GENERATED DAILY LOG -->",
    ].join("\n");
    await fs.writeFile(absolutePath, generated, "utf-8");

    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(createWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });

    await runWrite(wrapped, root, generated);

    const after = await fs.readFile(absolutePath, "utf-8");
    const markers = after.match(/BEGIN GENERATED DAILY LOG/g) ?? [];
    const stamps = after.match(/generated_at: 2026-09-11T12:00:01\.895262Z/g) ?? [];

    // The identical generated_at stamp is a cheap idempotency key that the
    // wrapper ignores entirely — every logged incident shares this invariant.
    expect(markers).toHaveLength(2);
    expect(stamps).toHaveLength(2);
  });
});
