export type SigningEmailInput = {
  contractTitle: string;
  companyName: string;
  signerName: string;
  signingUrl: string;
  expiresAt?: Date | null;
  supportContact?: string;
};

export function renderContractSigningEmail(input: SigningEmailInput) {
  const expiration = input.expiresAt ? `<p>This secure signing link expires on ${input.expiresAt.toISOString()}.</p>` : "";
  const support = input.supportContact ?? "info@mypaylink.app";
  return {
    from: "info@mypaylink.app",
    subject: `Contract ready for signature - ${input.contractTitle}`,
    text: `Hello ${input.signerName},\n\n${input.companyName} has sent you a contract for signature.\n\nView and sign here:\n${input.signingUrl}\n\nIf the button does not work, copy and paste the link into your browser.\n\nSupport: ${support}\n\nThank you,\nMyPayLink`,
    html: `<p>Hello ${input.signerName},</p><p>${input.companyName} has sent you a contract for signature.</p>${expiration}<p><a href="${input.signingUrl}">View in PayLink</a></p><p>If the button does not work, copy and paste this link into your browser:<br>${input.signingUrl}</p><p>Support: ${support}</p><p>Thank you,<br>MyPayLink</p>`,
  };
}
