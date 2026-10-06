export async function loadThankYouStickerPreview(
  token: string | null,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher("/api/print/preview/thank-you-label?name=Sample%20Customer", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Sticker preview failed (HTTP ${response.status})`);
  }
  const blob = await response.blob();
  if (blob.type !== "image/png") throw new Error("Sticker preview response was not a PNG image");
  return URL.createObjectURL(blob);
}
