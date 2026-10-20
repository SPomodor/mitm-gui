import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "chls-csp",
      transformIndexHtml(html: string) {
        const scripts =
          command === "serve" ? "'self' 'unsafe-inline'" : "'self'";
        return html.replace("__SCRIPT_POLICY__", scripts);
      },
    },
  ],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/.venv/**", "**/build/**", "**/runtime/**", "**/release/**"],
    },
  },
}));
