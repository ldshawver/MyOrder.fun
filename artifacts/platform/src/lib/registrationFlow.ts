export type RegistrationAction = "create_account" | "verify_code" | "resume_provisioning";

export function registrationAction(status: string | null | undefined): RegistrationAction {
  if (status === "complete") return "resume_provisioning";
  if (status === "missing_requirements") return "verify_code";
  return "create_account";
}

export function clerkRegistrationErrorKind(error: unknown): "already_verified" | "expired_code" | "duplicate_identity" | null {
  const code = (error as { errors?: Array<{ code?: string }> })?.errors?.[0]?.code?.toLowerCase() ?? "";
  if (code.includes("already_verified")) return "already_verified";
  if (code.includes("expired")) return "expired_code";
  if (code.includes("identifier_exists") || code.includes("email_address_taken")) return "duplicate_identity";
  return null;
}
