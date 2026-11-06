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

export type SignUpProgress = {
  status?: string | null;
  createdSessionId?: string | null;
  missingFields?: string[] | null;
  unverifiedFields?: string[] | null;
  emailVerificationStatus?: string | null;
};

type SignUpProgressSource = SignUpProgress & {
  verifications?: { emailAddress?: { status?: string | null } | null } | null;
};

function listedFields(signUp: SignUpProgress): string[] {
  return [...(signUp.missingFields ?? []), ...(signUp.unverifiedFields ?? [])];
}

function mentionsEmail(field: string): boolean {
  return field === "email_address" || field.includes("email");
}

export function readSignUpProgress(signUp: SignUpProgressSource | null | undefined): SignUpProgress {
  return {
    status: signUp?.status ?? null,
    createdSessionId: signUp?.createdSessionId ?? null,
    missingFields: signUp?.missingFields ?? [],
    unverifiedFields: signUp?.unverifiedFields ?? [],
    emailVerificationStatus: signUp?.emailVerificationStatus ?? signUp?.verifications?.emailAddress?.status ?? null,
  };
}

/** A session exists only when Clerk says the sign-up is complete or already issued one. */
export function signUpReadyToFinish(signUp: SignUpProgress): boolean {
  return signUp.status === "complete" || Boolean(signUp.createdSessionId);
}

/** Ask for a code only while the email itself is still unverified. */
export function signUpNeedsEmailCode(signUp: SignUpProgress): boolean {
  if (signUpReadyToFinish(signUp)) return false;
  if (signUp.emailVerificationStatus === "verified") return false;
  return listedFields(signUp).some(mentionsEmail);
}

export function signUpNeedsFullName(signUp: SignUpProgress): boolean {
  return listedFields(signUp).some((field) => field === "first_name" || field === "last_name");
}

/** Clerk reports this when the dashboard requires terms acceptance and the attempt has not sent it. */
export function signUpNeedsLegalAcceptance(signUp: SignUpProgress): boolean {
  return listedFields(signUp).some((field) => field === "legal_accepted");
}

/** Email verification can succeed while Clerk still requires the password on the attempt. */
export function signUpNeedsPassword(signUp: SignUpProgress): boolean {
  return listedFields(signUp).some((field) => field === "password");
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } | null {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const [firstName, ...rest] = parts;
  return { firstName, lastName: rest.join(" ") };
}

export function verifiedSignUpBlocker(signUp: SignUpProgress): string {
  if (signUpReadyToFinish(signUp)) return "";
  if (signUpNeedsEmailCode(signUp)) return "Enter the code from your email to finish.";
  if (signUpNeedsFullName(signUp)) {
    return "Enter your first and last name. Your email is already verified, so you do not need another code.";
  }
  if (signUpNeedsLegalAcceptance(signUp)) {
    return "Accept the membership terms to finish creating your account. Your email is already verified.";
  }
  if (signUpNeedsPassword(signUp)) {
    return "Enter a password to finish creating your account. Your email is already verified.";
  }
  const missing = [...new Set(listedFields(signUp))].filter((field) => field !== "legal_accepted" && field !== "password");
  if (missing.length > 0) {
    return `Your email is verified. These fields are still required: ${missing.join(", ")}.`;
  }
  return "Your email is verified. Refresh the page and retry access setup. You do not need another code.";
}
