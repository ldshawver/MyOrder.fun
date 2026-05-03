import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function getPort(): number {
  const rawPort = process.env.PORT;

  if (!rawPort) {
    return 5173;
  }

  const port = Number(rawPort);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  return port;
}

function getBasePath(): string {
  const rawBasePath = process.env.BASE_PATH;

  if (!rawBasePath) {
    return "/";
  }

  const basePath = rawBasePath.trim();

  if (!basePath.startsWith("/")) {
    throw new Error(
      `Invalid BASE_PATH value: "${rawBasePath}". BASE_PATH must start with "/".`,
    );
  }

  return basePath;
}

async function getPlugins(): Promise<PluginOption[]> {
  const plugins: PluginOption[] = [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
  ];

  const isReplitDev =
    process.env.NODE_ENV !== "production" &&
    typeof process.env.REPL_ID !== "undefined";

  if (isReplitDev) {
    const [{ cartographer }, { devBanner }] = await Promise.all([
      import("@replit/vite-plugin-cartographer"),
      import("@replit/vite-plugin-dev-banner"),
    ]);

    plugins.push(
      cartographer({
        root: repoRoot,
      }),
      devBanner(),
    );
  }

  return plugins;
}

export default defineConfig(async () => {
  const port = getPort();
  const basePath = getBasePath();

  // Replit testing uses PUBLIC_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY secrets.
  // Production builds read VITE_CLERK_PUBLISHABLE_KEY from the server .env file.
  const clerkPublishableKey =
    process.env.PUBLIC_KEY ||
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    process.env.VITE_CLERK_PUBLISHABLE_KEY ||
    "";

  return {
    base: basePath,
    plugins: await getPlugins(),
    define: {
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(clerkPublishableKey),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
      dedupe: [
        "react",
        "react-dom",
        "@tanstack/react-query",
        "@radix-ui/react-tooltip",
        "@clerk/react",
        "@clerk/shared",
      ],
      preserveSymlinks: true,
    },
    optimizeDeps: {
      include: [
        "@radix-ui/react-tooltip",
        "regexparam",
        "@clerk/react",
        "@clerk/shared",
      ],
    },
    server: {
      host: true,
      port,
      strictPort: true,
      allowedHosts: true,
    },
    preview: {
      host: true,
      port,
      strictPort: true,
    },
    build: {
      sourcemap: true,
    },
  };
});
