import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clerkRegistrationErrorKind,
  readSignUpProgress,
  registrationAction,
  signUpNeedsEmailCode,
  signUpNeedsFullName,
  signUpNeedsLegalAcceptance,
  signUpNeedsPassword,
  signUpReadyToFinish,
  splitFullName,
  verifiedSignUpBlocker,
} from "../registrationFlow";

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

  it("asks for an email code only while that address is still unverified", () => {
    expect(signUpNeedsEmailCode({ status: "complete", unverifiedFields: ["email_address"] })).toBe(false);
    expect(signUpNeedsEmailCode({ createdSessionId: "sess_1", unverifiedFields: ["email_address"] })).toBe(false);
    expect(signUpNeedsEmailCode({
      status: "missing_requirements",
      emailVerificationStatus: "verified",
      unverifiedFields: ["email_address"],
    })).toBe(false);
    expect(signUpNeedsEmailCode({ status: "missing_requirements", unverifiedFields: ["email_address"] })).toBe(true);
    expect(signUpNeedsEmailCode({ status: "missing_requirements", missingFields: ["last_name"] })).toBe(false);
  });

  it("finishes only when a session exists and still collects a missing last name", () => {
    expect(signUpReadyToFinish({ status: "complete" })).toBe(true);
    expect(signUpReadyToFinish({ status: "missing_requirements", createdSessionId: "sess_1" })).toBe(true);
    expect(signUpReadyToFinish({ status: "missing_requirements", emailVerificationStatus: "verified" })).toBe(false);
    expect(signUpNeedsFullName({ missingFields: ["last_name"] })).toBe(true);
    expect(signUpNeedsFullName({ unverifiedFields: ["email_address"] })).toBe(false);
    expect(splitFullName("Ada")).toBeNull();
    expect(splitFullName("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(splitFullName("Ada Lovelace Byron")).toEqual({ firstName: "Ada", lastName: "Lovelace Byron" });
    expect(verifiedSignUpBlocker({ status: "missing_requirements", missingFields: ["last_name"] }))
      .toContain("first and last name");
    expect(signUpNeedsLegalAcceptance({ missingFields: ["legal_accepted"], emailVerificationStatus: "verified" })).toBe(true);
    expect(signUpNeedsLegalAcceptance({ missingFields: ["last_name"] })).toBe(false);
    expect(verifiedSignUpBlocker({
      status: "missing_requirements",
      emailVerificationStatus: "verified",
      missingFields: ["legal_accepted"],
    })).toBe("Accept the membership terms to finish creating your account. Your email is already verified.");
    expect(signUpNeedsPassword({ missingFields: ["password"], emailVerificationStatus: "verified" })).toBe(true);
    expect(signUpNeedsPassword({ missingFields: ["last_name"] })).toBe(false);
    expect(verifiedSignUpBlocker({
      status: "missing_requirements",
      emailVerificationStatus: "verified",
      missingFields: ["password"],
    })).toBe("Enter a password to finish creating your account. Your email is already verified.");
  });

  it("sends Clerk legal acceptance from the member registration form", () => {
    const source = readFileSync(new URL("../../pages/waitlist.tsx", import.meta.url), "utf8");
    expect(source).toContain("legalAccepted: true");
    expect(source).toContain('data-testid="signup-legal-accepted"');
    expect(source).toContain("signUpNeedsLegalAcceptance");
    expect(source).toContain("/terms-of-service");
    expect(source).not.toContain("still required: legal_accepted");
    expect(source).toContain("submitVerifiedPassword(password)");
    expect(source).toContain('data-testid="signup-finish-password"');
    expect(source).toContain("Access stays pending until an admin approves the account.");
    expect(source).not.toContain('status: "approved"');
    expect(readSignUpProgress({
      status: "missing_requirements",
      verifications: { emailAddress: { status: "verified" } },
      missingFields: ["last_name"],
    })).toMatchObject({ emailVerificationStatus: "verified", status: "missing_requirements" });
  });
});
