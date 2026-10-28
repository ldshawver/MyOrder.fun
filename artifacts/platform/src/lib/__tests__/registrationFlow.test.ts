import { describe, expect, it } from "vitest";
import { clerkRegistrationErrorKind, registrationAction } from "../registrationFlow";

describe("member registration recovery state", () => {
  it("starts new sign-ups, verifies pending email codes, and resumes completed verification without reusing the code", () => {
    expect(registrationAction(null)).toBe("create_account");
    expect(registrationAction("missing_requirements")).toBe("verify_code");
    expect(registrationAction("complete")).toBe("resume_provisioning");
  });

  it("classifies already-verified, expired-code, and duplicate-identity errors without exposing account existence", () => {
    expect(clerkRegistrationErrorKind({ errors: [{ code: "verification_already_verified" }] })).toBe("already_verified");
    expect(clerkRegistrationErrorKind({ errors: [{ code: "verification_expired" }] })).toBe("expired_code");
    expect(clerkRegistrationErrorKind({ errors: [{ code: "form_identifier_exists" }] })).toBe("duplicate_identity");
    expect(clerkRegistrationErrorKind({ errors: [{ code: "unknown_error" }] })).toBeNull();
  });
});
