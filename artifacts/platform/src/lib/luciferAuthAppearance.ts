export const luciferAuthAppearance = {
  variables: {
    colorPrimary: "#8b0000",
    colorDanger: "#dc143c",
    colorBackground: "#151010",
    colorText: "#ffffff",
    colorTextSecondary: "#ffffff",
    colorInputBackground: "#ffffff",
    colorInputText: "#111111",
    colorRing: "#dc143c",
  },
  elements: {
    headerTitle: { display: "none" },
    card: { backgroundColor: "#151010", color: "#ffffff", border: "1px solid #492126", boxShadow: "0 20px 60px rgba(0,0,0,.4)" },
    formButtonPrimary: { backgroundColor: "#8b0000", color: "#ffffff" },
    formFieldInput: { borderColor: "#111111", backgroundColor: "#ffffff", color: "#111111" },
    formFieldLabel: { color: "#ffffff" },
    footerActionLink: { color: "#ff526b" },
    formFieldInputShowPasswordButton: { color: "#111111" },
  },
} as const;

/** Clerk's own stylesheet can paint light text on a light field. Force the opposite pairing. */
export const luciferAuthContrastCss = `
.cl-card, .cl-cardBox, .cl-footer, .cl-footerPages, .cl-scrollBox, .cl-header, .cl-main {
  background-color: #151010 !important;
  color: #ffffff !important;
}
.cl-headerTitle, .cl-headerSubtitle, .cl-formFieldLabel, .cl-formFieldHintText,
.cl-identityPreviewText, .cl-identityPreviewEditButton, .cl-footerActionText,
.cl-dividerText, .cl-alertText, .cl-formHeaderTitle, .cl-formHeaderSubtitle {
  color: #ffffff !important;
}
.cl-formFieldInput, .cl-otpCodeFieldInput, .cl-input {
  background-color: #ffffff !important;
  color: #111111 !important;
  -webkit-text-fill-color: #111111 !important;
  caret-color: #111111 !important;
  border-color: #111111 !important;
}
.cl-formFieldInput::placeholder, .cl-otpCodeFieldInput::placeholder {
  color: #444444 !important;
  -webkit-text-fill-color: #444444 !important;
}
.cl-formFieldInput:-webkit-autofill, .cl-formFieldInput:-webkit-autofill:hover, .cl-formFieldInput:-webkit-autofill:focus {
  -webkit-text-fill-color: #111111 !important;
  box-shadow: 0 0 0 1000px #ffffff inset !important;
}
.cl-formButtonPrimary {
  background-color: #8b0000 !important;
  color: #ffffff !important;
}
.cl-formFieldInputShowPasswordButton, .cl-formFieldAction__password {
  color: #111111 !important;
}
.cl-footerActionLink, .cl-formResendCodeLink {
  color: #ff526b !important;
}
.cl-socialButtonsBlockButton {
  background-color: #ffffff !important;
  color: #111111 !important;
  border: 1px solid #111111 !important;
}
.cl-socialButtonsBlockButtonText {
  color: #111111 !important;
}
`.trim();
