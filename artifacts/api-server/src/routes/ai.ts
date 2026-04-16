import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import {
  AiConciergeChatBody,
  AiConciergeChatResponse,
  AiUpsellSuggestionsBody,
  AiUpsellSuggestionsResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

function mapCatalogItem(i: typeof catalogItemsTable.$inferSelect) {
  return {
    id: i.id,
    tenantId: i.tenantId,
    name: i.name,
    description: i.description,
    category: i.category,
    sku: i.sku ?? undefined,
    price: parseFloat(i.price as string),
    compareAtPrice: i.compareAtPrice ? parseFloat(i.compareAtPrice as string) : undefined,
    stockQuantity: i.stockQuantity !== null && i.stockQuantity !== undefined
      ? parseInt(String(i.stockQuantity), 10)
      : undefined,
    isAvailable: i.isAvailable,
    imageUrl: i.imageUrl,
    tags: i.tags ?? [],
    metadata: i.metadata,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

async function callAI(systemPrompt: string, messages: Array<{ role: string; content: string }>) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("AI service not configured");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      max_tokens: 800,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI API error: ${response.status}`);
  }

  const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

// POST /api/ai/chat
router.post("/ai/chat", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const body = AiConciergeChatBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  // Fetch live catalog data for context
  const catalog = await db.select().from(catalogItemsTable)
    .orderBy(asc(catalogItemsTable.name));

  const catalogContext = catalog
    .filter(i => i.isAvailable)
    .slice(0, 30)
    .map(i => `- ${i.name} (${i.category}) $${parseFloat(i.price as string).toFixed(2)}${i.description ? ": " + i.description : ""}`)
    .join("\n");

  const systemPrompt = `You are OrderFlow's AI sales concierge — an expert, trustworthy assistant helping customers find exactly what they need.

Your catalog today:
${catalogContext || "No items available."}

Guidelines:
- Be helpful, professional, and specific. Reference actual product names and prices.
- Suggest complementary products intelligently based on what the customer mentions.
- Never invent products that aren't in the catalog.
- Keep responses concise (2-4 sentences unless more detail is needed).
- If asked about something outside your catalog, politely redirect to what you do offer.
- You are a sales assistant, so be enthusiastic about helping customers find value.`;

  let reply = "";
  let suggestedItems: typeof catalogItemsTable.$inferSelect[] = [];

  try {
    reply = await callAI(systemPrompt, body.data.messages);

    // Extract mentioned product names from the reply to suggest
    const mentionedNames = catalog.filter(i =>
      reply.toLowerCase().includes(i.name.toLowerCase())
    ).slice(0, 3);
    suggestedItems = mentionedNames;
  } catch (err) {
    logger.error({ err }, "AI chat failed");
    // Fallback response
    reply = `I'd be happy to help you explore our catalog! We have ${catalog.length} products available. What type of product are you looking for today?`;
    suggestedItems = catalog.filter(i => i.isAvailable).slice(0, 3);
  }

  const conversationId = `conv_${Date.now()}`;
  res.json(AiConciergeChatResponse.parse({
    reply,
    suggestedItems: suggestedItems.map(mapCatalogItem),
    conversationId,
  }));
});

// POST /api/ai/upsell
router.post("/ai/upsell", async (req, res): Promise<void> => {
  const body = AiUpsellSuggestionsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const catalog = await db.select().from(catalogItemsTable)
    .orderBy(asc(catalogItemsTable.name));

  // Get current cart items
  const cartItems = catalog.filter(i => body.data.cartItemIds.includes(i.id));
  const otherItems = catalog.filter(i => !body.data.cartItemIds.includes(i.id) && i.isAvailable);

  const cartContext = cartItems.map(i => `${i.name} (${i.category})`).join(", ");
  const otherContext = otherItems.slice(0, 20).map(i => `${i.name} (${i.category}) $${parseFloat(i.price as string).toFixed(2)}`).join("\n");

  let reasoning = "";
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

    const parsed = JSON.parse(aiReply.replace(/```json\n?|\n?```/g, "").trim());
    suggestedIds = (parsed.suggestions ?? []).slice(0, 3);
    reasoning = parsed.reasoning ?? "";
  } catch {
    // Fallback: suggest different-category items
    const cartCategories = new Set(cartItems.map(i => i.category));
    suggestedIds = otherItems
      .filter(i => !cartCategories.has(i.category))
      .slice(0, 3)
      .map(i => i.id);
    reasoning = "Products from complementary categories";
  }

  const suggestions = catalog.filter(i => suggestedIds.includes(i.id));
  res.json(AiUpsellSuggestionsResponse.parse({
    suggestions: suggestions.map(mapCatalogItem),
    reasoning,
  }));
});

export default router;
