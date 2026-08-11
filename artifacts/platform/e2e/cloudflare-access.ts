import type { BrowserContext } from "@playwright/test";

const developmentOrigin = "https://dev.myorder.fun";

export async function installDevelopmentCloudflareAccess(context: BrowserContext, baseURL: string) {
  const origin = new URL(baseURL).origin;
  if (origin !== developmentOrigin) return;

  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Cloudflare Access service-token variables are required for development browser tests");
  }

  await context.route(`${developmentOrigin}/**`, async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== developmentOrigin) {
      await route.continue();
      return;
    }
    await route.continue({
      headers: {
        ...request.headers(),
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
    });
  });
}
