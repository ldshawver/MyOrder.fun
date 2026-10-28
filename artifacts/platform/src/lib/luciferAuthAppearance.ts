export const luciferAuthAppearance = {
  variables: {
    colorPrimary: "#8b0000",
    colorDanger: "#dc143c",
    colorBackground: "#151010",
    colorText: "#f5eeee",
    colorTextSecondary: "#c0c0c0",
    colorInputBackground: "#211919",
    colorInputText: "#f5eeee",
    colorRing: "#dc143c",
  },
  elements: {
    headerTitle: { display: "none" },
    card: { backgroundColor: "#151010", border: "1px solid #492126", boxShadow: "0 20px 60px rgba(0,0,0,.4)" },
    formButtonPrimary: { backgroundColor: "#8b0000", color: "#fff" },
    formFieldInput: { borderColor: "#55343a", backgroundColor: "#211919", color: "#f5eeee" },
    formFieldLabel: { color: "#d6caca" },
    footerActionLink: { color: "#ff526b" },
    formFieldInputShowPasswordButton: { color: "#c0c0c0" },
  },
} as const;
