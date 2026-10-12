import { describe, expect, it, vi } from "vitest";
import { loadThankYouStickerPreview } from "../thankYouStickerPreview";

describe("Thank You sticker preview", () => {
  it("loads the authorized sample PNG preview without creating a print job", async () => {
    const fetcher = vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }));
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sample-preview");
    await expect(loadThankYouStickerPreview("admin-token", fetcher)).resolves.toBe("blob:sample-preview");
    expect(fetcher).toHaveBeenCalledWith("/api/print/preview/thank-you-label?name=Sample%20Customer", {
      headers: { Authorization: "Bearer admin-token" }, cache: "no-store",
    });
    expect(createUrl).toHaveBeenCalledTimes(1);
    createUrl.mockRestore();
  });

  it("rejects an unexpected image response", async () => {
    const fetcher = vi.fn(async () => new Response("not an image", { status: 200, headers: { "Content-Type": "text/plain" } }));
    await expect(loadThankYouStickerPreview("admin-token", fetcher)).rejects.toThrow("not a PNG image");
  });

  it("does not surface response bodies from failed preview requests", async () => {
    const fetcher = vi.fn(async () => new Response("internal diagnostic", { status: 500 }));
    const error = await loadThankYouStickerPreview("admin-token", fetcher).catch((value: unknown) => value as Error);
    expect(error.message).toBe("Sticker preview failed (HTTP 500)");
    expect(error.message).not.toContain("internal diagnostic");
  });
});
