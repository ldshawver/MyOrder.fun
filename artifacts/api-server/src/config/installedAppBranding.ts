import type { PublicStorefrontBranding } from "./publicStorefrontBranding";

export function installedAppBranding(branding: PublicStorefrontBranding) {
  const lucifer = branding.customer.displayName.trim().toLowerCase() === "lucifer cruz";
  return {
    name: lucifer ? "Lucifer Cruz Order" : branding.customer.displayName,
    shortName: lucifer ? "LC Order" : branding.customer.displayName,
    faviconUrl: lucifer ? "/branding/lucifer-cruz/fav.png?v=11a07edd" : branding.customer.faviconUrl,
    iconUrl: lucifer
      ? "/branding/lucifer-cruz/LC-Order_Icon-iOS-Default-1024@1x.png?v=11ec8ee3"
      : branding.customer.logoUrl,
    iconSize: lucifer ? "1024x1024" : "any",
  };
}
