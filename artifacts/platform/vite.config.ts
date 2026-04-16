import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function getRequiredPort(): number {
  const rawPort = process.env.PORT;

  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = Number(rawPort);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  return port;
}

function getRequiredBasePath(): string {
  const rawBasePath = process.env.BASE_PATH;

  if (!rawBasePath) {
    throw new Error(
      "BASE_PATH environment variable is required but was not provided.",
    );
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
  const port = getRequiredPort();
  const basePath = getRequiredBasePath();

  return {
    base: basePath,
    plugins: await getPlugins(),
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
      host: "0.0.0.0",
      port,
      strictPort: true,
    },
    preview: {
      host: "0.0.0.0",
      port,
      strictPort: true,
    },
    build: {
      sourcemap: true,
    },
  };
});
