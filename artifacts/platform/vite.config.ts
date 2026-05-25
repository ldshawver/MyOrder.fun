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
    {
      name: "stdin-keep-alive",
      apply: "serve",
      configureServer() {
        // In Replit workflow environments the runner provides a PTY, so
        // process.stdin.isTTY is true.  When the runner closes the PTY master
        // side (after detecting the port is open) the process receives SIGHUP.
        // Node's default SIGHUP action is exit — override it to stay alive.
        process.on("SIGHUP", () => {});

        // Non-TTY fallback: Vite 5.4+ watches stdin and calls process.exit(0)
        // when stdin closes.  In environments where stdin is /dev/null the
        // close fires immediately after startup.  Remove those listeners.
        if (!process.stdin.isTTY) {
          process.stdin.removeAllListeners("close");
          process.stdin.removeAllListeners("end");
          process.stdin.unref();
        }
      },
    } satisfies PluginOption,
  ];

  const isReplitDev =
    process.env.NODE_ENV !== "production" &&
    typeof process.env.REPL_ID !== "undefined";

  if (isReplitDev) {
    const { cartographer } = await import("@replit/vite-plugin-cartographer");
    plugins.push(cartographer({ root: repoRoot }));
  }

  return plugins;
}

export default defineConfig(async () => {
  const port = getPort();
  const basePath = getBasePath();

  // Replit dev uses PUBLIC_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY secrets.
  // Production Docker builds pass VITE_CLERK_PUBLISHABLE_KEY as a build arg.
  // Normalise all three into VITE_CLERK_PUBLISHABLE_KEY so Vite's automatic
  // VITE_* injection picks it up — no manual `define` needed or wanted.
  if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
    process.env.VITE_CLERK_PUBLISHABLE_KEY =
      process.env.PUBLIC_KEY ||
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
      "";
  }

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
      host: "::",
      port,
      strictPort: true,
      allowedHosts: true,
    },
    preview: {
      host: "::",
      port,
      strictPort: true,
    },
    build: {
      sourcemap: true,
    },
  };
});
