export const PLATFORM_BRAND = {
  displayName: "MyOrder.fun",
  legalName: "MyOrder.fun",
  logoUrl: "/myorder-logo-header.webp",
  mobileLogoUrl: "/myorder-logo-mobile.png",
  faviconUrl: "/favicon-32.png",
  primaryColor: "#0878f9",
  secondaryColor: "#062d73",
} as const;

export type CustomerBranding = {
  displayName: string;
  legalName: string | null;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  secondaryColor: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  checkoutDescriptor: string | null;
  termsDisclaimer: string | null;
  privacyNotice: string | null;
  customDomain: string | null;
  domainVerificationState: "unconfigured" | "pending" | "verified" | "failed";
  businessDescription: string | null;
};

export type SupplierBranding = {
  displayName: string | null;
  logoUrl: string | null;
  attribution: string | null;
  disclaimer: string | null;
  showAttribution: boolean;
};

export type ResolvedBranding = {
  platform: typeof PLATFORM_BRAND;
  customer: CustomerBranding;
  supplier: SupplierBranding;
};

export type BrandingInput = {
  customer?: Partial<CustomerBranding> | null;
  supplier?: Partial<SupplierBranding> | null;
};

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

export function resolveBranding(input?: BrandingInput | null): ResolvedBranding {
  const customer = input?.customer ?? {};
  const supplier = input?.supplier ?? {};
  const verification = customer.domainVerificationState;
  return {
    platform: PLATFORM_BRAND,
    customer: {
      displayName: text(customer.displayName) ?? PLATFORM_BRAND.displayName,
      legalName: text(customer.legalName),
      logoUrl: text(customer.logoUrl) ?? PLATFORM_BRAND.logoUrl,
      faviconUrl: text(customer.faviconUrl) ?? PLATFORM_BRAND.faviconUrl,
      primaryColor: text(customer.primaryColor) ?? PLATFORM_BRAND.primaryColor,
      secondaryColor: text(customer.secondaryColor) ?? PLATFORM_BRAND.secondaryColor,
      supportEmail: text(customer.supportEmail),
      supportPhone: text(customer.supportPhone),
      websiteUrl: text(customer.websiteUrl),
      checkoutDescriptor: text(customer.checkoutDescriptor),
      termsDisclaimer: text(customer.termsDisclaimer),
      privacyNotice: text(customer.privacyNotice),
      customDomain: text(customer.customDomain),
      domainVerificationState: ["pending", "verified", "failed"].includes(String(verification))
        ? verification as CustomerBranding["domainVerificationState"]
        : "unconfigured",
      businessDescription: text(customer.businessDescription),
    },
    supplier: {
      displayName: text(supplier.displayName),
      logoUrl: text(supplier.logoUrl),
      attribution: text(supplier.attribution),
      disclaimer: text(supplier.disclaimer),
      showAttribution: supplier.showAttribution === true,
    },
  };
}

export function visibleSupplierAttribution(branding: ResolvedBranding): string | null {
  return branding.supplier.showAttribution ? branding.supplier.attribution : null;
}
