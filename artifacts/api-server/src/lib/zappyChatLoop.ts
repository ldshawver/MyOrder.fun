// Runs the model with Zappy's tools. Account tools (order status/history,
// credit) execute server-side and their results are fed back to the model;
// cart tools are only *proposed* back to the client, as before.
import { isOrderTool, runOrderTool, type OrderToolDeps } from "./zappyOrderTools";
import { logger } from "./logger";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ModelMessage = { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };

export const MAX_TOOL_ROUNDS = 2;
export const MAX_TOOL_CALLS_PER_ROUND = 3;

function parseArgs(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function runChatWithAccountTools(opts: {
  systemPrompt: string;
  messages: Array<Record<string, unknown>>;
  ctx: { tenantId: number; customerId: number };
  call: (messages: Array<Record<string, unknown>>) => Promise<ModelMessage>;
  deps?: OrderToolDeps;
}): Promise<ModelMessage> {
  const convo = [...opts.messages];
  const proposedCartCalls: ToolCall[] = [];

  for (let round = 0; ; round++) {
    const msg = await opts.call(convo);
    const calls = msg.tool_calls ?? [];
    const accountCalls = calls.filter(c => isOrderTool(c.function.name));
    proposedCartCalls.push(...calls.filter(c => !isOrderTool(c.function.name)));

    if (accountCalls.length === 0 || round >= MAX_TOOL_ROUNDS) {
      return { role: "assistant", content: msg.content, tool_calls: proposedCartCalls.length ? proposedCartCalls : undefined };
    }

    // Every tool_call id in the assistant turn needs a matching tool message.
    convo.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    let executed = 0;
    for (const c of calls) {
      let result: Record<string, unknown>;
      if (!isOrderTool(c.function.name)) {
        result = { status: "proposed_to_customer" };
      } else if (executed >= MAX_TOOL_CALLS_PER_ROUND) {
        result = { error: "too_many_lookups" };
      } else {
        executed++;
        try {
          result = await runOrderTool(c.function.name, parseArgs(c.function.arguments), opts.ctx, opts.deps);
        } catch (err) {
          logger.warn({ err, tool: c.function.name }, "Zappy account lookup failed");
          result = { error: "lookup_failed" };
        }
      }
      // Tool output is data, never instructions.
      convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ data: result }) });
    }
  }
}
