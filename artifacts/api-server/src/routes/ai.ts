import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, asc, or, like, eq, sql } from "drizzle-orm";
import { db, catalogItemsTable, adminSettingsTable } from "@workspace/db";
import {
  AiConciergeChatBody,
  AiConciergeChatResponse,
  AiUpsellSuggestionsBody,
  AiUpsellSuggestionsResponse,
  AiCatalogSearchBody,
  AiCatalogSearchResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

export const DEFAULT_AI_CONCIERGE_PROMPT = `You are Zappy — the friendly AI order concierge for Lucifer Cruz Adult Boutique. Your job is to help customers find what they need.

CURRENT CATALOG ({{itemCount}} items available):
{{catalog}}

{{cart_context}}

CORE RULES:
- Always be warm, direct, and helpful. Skip filler phrases like "Great question!" or "Certainly!".
- Reference real product names and prices from the catalog above. Never invent products.
- When a customer describes what they want or asks about a product, identify the best 1-2 matching items and reply: "I found [Name] for $[Price]. Want me to add that to your cart?" — do NOT call add_to_cart yet.
- Only call add_to_cart AFTER the customer explicitly confirms (yes, sure, add it, go ahead, sounds good, etc.).
- When a customer asks to remove something from their cart, use remove_from_cart.
- If they ask what's popular, recommend 2-3 items from different categories with prices and ask if they'd like any added.
- Keep replies to 2-4 sentences. Be conversational, not corporate.
- If the catalog is empty, apologize and suggest they check back soon.
- After calling add_to_cart, confirm: "Done! I added [Name] to your cart. Anything else?"`;


export function renderConciergePrompt(
  template: string,
  vars: { itemCount: number; catalog: string; cart_context?: string },
): string {
  return template
    .replaceAll("{{itemCount}}", String(vars.itemCount))
    .replaceAll("{{catalog}}", vars.catalog || "No items available right now.")
    .replaceAll("{{cart_context}}", vars.cart_context ?? "");
}

async function loadConciergePromptTemplate(): Promise<string> {
  try {
    const [row] = await db.select({ p: adminSettingsTable.aiConciergePrompt }).from(adminSettingsTable).limit(1);
    const stored = row?.p?.trim();
    return stored && stored.length > 0 ? stored : DEFAULT_AI_CONCIERGE_PROMPT;
  } catch (err) {
    logger.warn({ err }, "AI concierge prompt unavailable; using built-in default");
    return DEFAULT_AI_CONCIERGE_PROMPT;
  }
}

async function loadAvailableCatalog(tenantId: number): Promise<Array<typeof catalogItemsTable.$inferSelect>> {
  try {
    return await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.isAvailable, true), eq(catalogItemsTable.alavontInStock, true), eq(catalogItemsTable.isWooManaged, false), sql`coalesce(${catalogItemsTable.isLocalAlavont}, true) = true`, sql`coalesce((${catalogItemsTable.metadata}->>'archived')::boolean, false) = false`, sql`coalesce((${catalogItemsTable.metadata}->>'safeOnlyDuplicate')::boolean, false) = false`)).orderBy(asc(catalogItemsTable.alavontName));
  } catch (err) {
    logger.error({ err }, "AI catalog load failed");
    return [];
  }
}

function mapCatalogItem(i: typeof catalogItemsTable.$inferSelect) {
  return {
    id: i.id,
    tenantId: i.tenantId,
    name: i.alavontName ?? i.name,
    description: i.alavontDescription ?? i.description,
    category: i.alavontCategory ?? i.category,
    sku: i.sku ?? undefined,
    price: parseFloat(i.price as string),
    compareAtPrice: i.compareAtPrice ? parseFloat(i.compareAtPrice as string) : undefined,
    stockQuantity: i.stockQuantity !== null && i.stockQuantity !== undefined
      ? parseInt(String(i.stockQuantity), 10)
      : undefined,
    isAvailable: i.isAvailable,
    imageUrl: i.alavontImageUrl ?? i.imageUrl,
    tags: i.tags ?? [],
    metadata: i.metadata,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

// Plain text completion — used by upsell and fallback
async function callAI(systemPrompt: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI service not configured");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 800,
      temperature: 0.7,
    }),
  });

  if (!response.ok) throw new Error(`AI API error: ${response.status}`);
  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

type OpenAITool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

// Function-calling enabled completion — used by the chat endpoint
async function callAIWithTools(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  tools: OpenAITool[],
): Promise<OpenAIMessage> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("AI service not configured");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      tools,
      tool_choice: "auto",
      max_tokens: 800,
      temperature: 0.7,
    }),
  });

  if (!response.ok) throw new Error(`AI API error: ${response.status}`);
  const data = (await response.json()) as { choices: Array<{ message: OpenAIMessage }> };
  return data.choices[0]?.message ?? { role: "assistant", content: "" };
}

const CART_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: "Add a catalog item to the customer's cart. Use this whenever the customer wants to order or add a product.",
      parameters: {
        type: "object",
        properties: {
          catalogItemId: { type: "integer", description: "The ID of the catalog item to add" },
          quantity: { type: "integer", description: "Quantity to add (default 1)", default: 1 },
          itemName: { type: "string", description: "Display name of the item being added" },
        },
        required: ["catalogItemId", "itemName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_cart",
      description: "Remove a catalog item from the customer's cart.",
      parameters: {
        type: "object",
        properties: {
          catalogItemId: { type: "integer", description: "The ID of the catalog item to remove" },
          itemName: { type: "string", description: "Display name of the item being removed" },
        },
        required: ["catalogItemId", "itemName"],
      },
    },
  },
];


// GET /api/admin/ai/product-master-options — admin dropdown source for upsells/packages/bundles.
router.get("/admin/ai/product-master-options", async (req, res): Promise<void> => {
  const actorRole = req.dbUser?.role;
  if (actorRole !== "global_admin" && actorRole !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const catalog = await loadAvailableCatalog(tenantId);
  const options = catalog.map(i => ({
    id: i.id,
    label: i.alavontName ?? i.name,
    category: i.alavontCategory ?? i.category,
    imageUrl: i.alavontImageUrl ?? i.imageUrl,
    price: parseFloat(i.price as string),
  }));
  res.json({ upsellOptions: options, packageOptions: options, bundleOptions: options });
});

// PATCH /api/admin/ai/product-master-config — persist catalog-backed AI relationship ids in metadata.
router.patch("/admin/ai/product-master-config", async (req, res): Promise<void> => {
  const actorRole = req.dbUser?.role;
  if (actorRole !== "global_admin" && actorRole !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const body = z.object({
    catalogItemId: z.number().int().positive(),
    aiUpsellIds: z.array(z.number().int().positive()).max(50).optional(),
    packageIds: z.array(z.number().int().positive()).max(50).optional(),
    bundleIds: z.array(z.number().int().positive()).max(50).optional(),
  }).strict().safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const ids = [body.data.catalogItemId, ...(body.data.aiUpsellIds ?? []), ...(body.data.packageIds ?? []), ...(body.data.bundleIds ?? [])];
  const validRows = ids.length ? await db.select({ id: catalogItemsTable.id }).from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), sql`${catalogItemsTable.id} = ANY(${ids})`)) : [];
  const validIds = new Set(validRows.map(r => r.id));
  if (ids.some(id => !validIds.has(id))) { res.status(400).json({ error: "All AI/package/bundle product IDs must belong to this tenant catalog" }); return; }
  const [item] = await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, body.data.catalogItemId))).limit(1);
  const metadata = { ...(item?.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata as Record<string, unknown> : {}), ai: { aiUpsellIds: body.data.aiUpsellIds ?? [], packageIds: body.data.packageIds ?? [], bundleIds: body.data.bundleIds ?? [] } };
  const [updated] = await db.update(catalogItemsTable).set({ metadata }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, body.data.catalogItemId))).returning();
  res.json({ item: mapCatalogItem(updated) });
});

// POST /api/ai/chat
router.post("/ai/chat", async (req, res): Promise<void> => {
  const body = AiConciergeChatBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const catalog = await loadAvailableCatalog(tenantId);
  const availableItems = catalog;

  // Build catalog context with IDs so function calling can reference them
  const catalogContext = availableItems
    .slice(0, 50)
    .map(i => {
      const displayName = i.alavontName ?? i.name;
      const displayCat = i.alavontCategory ?? i.category;
      const desc = i.alavontDescription ?? i.description ?? "";
      return `[ID:${i.id}] ${displayName} (${displayCat}) $${parseFloat(i.price as string).toFixed(2)}${desc ? ": " + desc : ""}`;
    })
    .join("\n");

  // Build cart context section if the request includes cart items
  const incomingCart = body.data.cart ?? [];
  const cartContext = incomingCart.length > 0
    ? `CURRENT CART (${incomingCart.length} item types):\n${incomingCart.map(c => `- ${c.name ?? "Item"} x${c.quantity} ($${((c.price ?? 0) * c.quantity).toFixed(2)})`).join("\n")}`
    : "";

  const promptTemplate = await loadConciergePromptTemplate();
  const systemPrompt = renderConciergePrompt(promptTemplate, {
    itemCount: availableItems.length,
    catalog: catalogContext,
    cart_context: cartContext,
  });

  type CartAction = { action: "add" | "remove" | "update_quantity"; catalogItemId: number; quantity?: number; itemName?: string };
  let reply: string;
  let suggestedItems: typeof catalogItemsTable.$inferSelect[];
  const cartActions: CartAction[] = [];

  try {
    const aiMessage = await callAIWithTools(systemPrompt, body.data.messages, CART_TOOLS);

    // Process any tool calls
    if (aiMessage.tool_calls?.length) {
      for (const tc of aiMessage.tool_calls) {
        try {
          const args = JSON.parse(tc.function.arguments) as { catalogItemId?: number; quantity?: number; itemName?: string };
          const catalogItemId = args.catalogItemId;
          if (!catalogItemId) continue;
          // Validate the item exists in the catalog
          const exists = availableItems.find(i => i.id === catalogItemId);
          if (!exists) continue;

          if (tc.function.name === "add_to_cart") {
            cartActions.push({ action: "add", catalogItemId, quantity: args.quantity ?? 1, itemName: args.itemName });
          } else if (tc.function.name === "remove_from_cart") {
            cartActions.push({ action: "remove", catalogItemId, itemName: args.itemName });
          }
        } catch {
          // ignore parse errors for individual tool calls
        }
      }
    }

    reply = aiMessage.content ?? "";

    // If no text reply but we have cart actions, generate a confirmation
    if (!reply.trim() && cartActions.length > 0) {
      const addedNames = cartActions.filter(a => a.action === "add").map(a => a.itemName).filter(Boolean);
      const removedNames = cartActions.filter(a => a.action === "remove").map(a => a.itemName).filter(Boolean);
      const parts: string[] = [];
      if (addedNames.length) parts.push(`Added ${addedNames.join(" and ")} to your cart ✓`);
      if (removedNames.length) parts.push(`Removed ${removedNames.join(" and ")} from your cart ✓`);
      reply = parts.join(" · ") + " Ready to keep shopping or head to checkout?";
    }

    // Suggest items from tool calls first, then fall back to name mentions
    const toolItemIds = cartActions.map(a => a.catalogItemId);
    let mentionedItems = availableItems.filter(i => toolItemIds.includes(i.id)).slice(0, 3);
    if (mentionedItems.length === 0 && reply) {
      const replyLow = reply.toLowerCase();
      mentionedItems = availableItems.filter(i =>
        replyLow.includes(i.name.toLowerCase()) ||
        (i.alavontName && replyLow.includes(i.alavontName.toLowerCase()))
      ).slice(0, 3);
    }
    suggestedItems = mentionedItems;
  } catch (err) {
    logger.error({ err }, "AI chat failed");

    const lastUserMsg = [...body.data.messages].reverse().find(m => m.role === "user")?.content?.toLowerCase() ?? "";

    if (availableItems.length === 0) {
      reply = "Looks like the catalog is empty right now — check back soon and we'll have everything loaded up for you! 🛍️";
      suggestedItems = [];
    } else if (lastUserMsg.includes("order") || lastUserMsg.includes("buy") || lastUserMsg.includes("get") || lastUserMsg.includes("want")) {
      const picks = availableItems.slice(0, 3);
      reply = `Let's build your order! Here are some items to get you started:\n${picks.map(i => `• ${i.alavontName ?? i.name} — $${parseFloat(i.price as string).toFixed(2)}`).join("\n")}`;
      suggestedItems = picks;
    } else if (lastUserMsg.includes("popular") || lastUserMsg.includes("best") || lastUserMsg.includes("recommend")) {
      const picks = availableItems.slice(0, 3);
      reply = `Here are some top picks right now:\n${picks.map(i => `• ${i.alavontName ?? i.name} (${i.alavontCategory ?? i.category}) — $${parseFloat(i.price as string).toFixed(2)}`).join("\n")}`;
      suggestedItems = picks;
    } else {
      const picks = availableItems.slice(0, 3);
      reply = `We've got ${availableItems.length} items available right now. Here's a quick look:\n${picks.map(i => `• ${i.alavontName ?? i.name} — $${parseFloat(i.price as string).toFixed(2)}`).join("\n")}\n\nWhat are you looking for?`;
      suggestedItems = picks;
    }
  }

  const conversationId = `conv_${Date.now()}`;
  res.json(AiConciergeChatResponse.parse({
    reply,
    suggestedItems: suggestedItems.map(mapCatalogItem),
    cartActions,
    conversationId,
  }));
});

// POST /api/ai/catalog-search
router.post("/ai/catalog-search", async (req, res): Promise<void> => {
  const body = AiCatalogSearchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { query, limit = 10 } = body.data;
  const q = query.trim().toLowerCase();

  try {
    const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
    const catalog = await db.select().from(catalogItemsTable)
      .where(and(
        eq(catalogItemsTable.tenantId, tenantId),
        eq(catalogItemsTable.isAvailable, true),
        eq(catalogItemsTable.alavontInStock, true),
        eq(catalogItemsTable.isWooManaged, false),
        sql`coalesce((${catalogItemsTable.metadata}->>'archived')::boolean, false) = false`,
        sql`coalesce((${catalogItemsTable.metadata}->>'safeOnlyDuplicate')::boolean, false) = false`,
        or(
              like(catalogItemsTable.alavontName, `%${q}%`),
          like(catalogItemsTable.alavontCategory, `%${q}%`),
          like(catalogItemsTable.alavontDescription, `%${q}%`),
        )
      ))
      .orderBy(asc(catalogItemsTable.alavontName))
      .limit(limit);

    res.json(AiCatalogSearchResponse.parse({ items: catalog.map(mapCatalogItem), query }));
  } catch (err) {
    logger.error({ err, query }, "AI catalog search failed");
    res.json(AiCatalogSearchResponse.parse({ items: [], query }));
  }
});

// POST /api/ai/upsell
router.post("/ai/upsell", async (req, res): Promise<void> => {
  const body = AiUpsellSuggestionsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const catalog = await loadAvailableCatalog(tenantId);
  const cartItems = catalog.filter(i => body.data.cartItemIds.includes(i.id));
  const otherItems = catalog.filter(i => !body.data.cartItemIds.includes(i.id));

  const cartContext = cartItems.map(i => `${i.alavontName ?? i.name} (${i.alavontCategory ?? i.category})`).join(", ");
  const otherContext = otherItems.slice(0, 20).map(i => `[ID:${i.id}] ${i.alavontName ?? i.name} (${i.alavontCategory ?? i.category}) $${parseFloat(i.price as string).toFixed(2)}`).join("\n");

  let reasoning: string;
  let suggestedIds: number[] = [];

  try {
    const prompt = `Customer has in their cart: ${cartContext || "nothing yet"}.

Available products:
${otherContext}

Suggest 3 complementary products that would pair well with what they already have. Return ONLY a JSON object like:
{"suggestions": [1, 2, 3], "reasoning": "Brief explanation"}
Where the numbers are product IDs from the list.`;

    const aiReply = await callAI("You are a concise product recommendation engine. Return only valid JSON.", [
      { role: "user", content: prompt },
    ]);

    const parsed = JSON.parse(aiReply.replace(/```json\n?|\n?```/g, "").trim()) as { suggestions?: number[]; reasoning?: string };
    suggestedIds = (parsed.suggestions ?? []).slice(0, 3);
    reasoning = parsed.reasoning ?? "";
  } catch {
    const cartCategories = new Set(cartItems.map(i => i.category));
    suggestedIds = otherItems.filter(i => !cartCategories.has(i.category)).slice(0, 3).map(i => i.id);
    reasoning = "Products from complementary categories";
  }

  const suggestions = catalog.filter(i => suggestedIds.includes(i.id));
  res.json(AiUpsellSuggestionsResponse.parse({
    suggestions: suggestions.map(mapCatalogItem),
    reasoning,
  }));
});

export default router;
