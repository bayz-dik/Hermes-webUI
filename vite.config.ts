import { defineConfig, type Plugin } from "vite";

/**
 * In `npm run dev` the page is served by Vite, not by server.py, so the raw
 * index.html on disk has no session token in it and every /api call would 403.
 *
 * This plugin asks the running server for its token and injects it into the
 * served HTML, exactly as server.py does in production. The token stays
 * per-process and in memory: it is never written to a file.
 */
function injectSessionToken(serverPort: number): Plugin {
  const TOKEN_RE = /name="hermes-web-token" content="([0-9a-f]+)"/;

  return {
    name: "hermes-console-session-token",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      async handler(html: string) {
        try {
          const res = await fetch(`http://127.0.0.1:${serverPort}/`, {
            headers: { Accept: "text/html" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const match = TOKEN_RE.exec(await res.text());
          if (!match?.[1]) throw new Error("no token meta tag in the server's HTML");
          return html.replace(
            "<head>",
            `<head>\n    <meta name="hermes-web-token" content="${match[1]}" />`,
          );
        } catch (error) {
          // Do not fail the page: render it with a visible explanation instead
          // of a blank screen with silent 403s.
          const reason = error instanceof Error ? error.message : String(error);
          this.warn(
            `Could not read a session token from the server on 127.0.0.1:${serverPort} (${reason}). ` +
              `Start it with: python3 server.py --port ${serverPort} --no-open`,
          );
          return html.replace(
            "<head>",
            `<head>\n    <meta name="hermes-web-token" content="" />` +
              `\n    <meta name="hermes-web-token-error" content="${reason.replace(/"/g, "'")}" />`,
          );
        }
      },
    },
  };
}

// The Python server's port. run.sh passes the same value it would serve on, so
// `./run.sh --dev --port 9000` keeps the proxy and the token lookup in step.
//
// Read off globalThis rather than the bare `process` global: the tsconfig sets
// `types: []` so no Node typings are pulled in, and adding @types/node for one
// environment variable is not worth the dependency.
const SERVER_PORT = Number(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.HERMES_CONSOLE_PORT ?? 8787,
);

export default defineConfig({
  root: ".",
  base: "/",
  plugins: [injectSessionToken(SERVER_PORT)],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: false,
      },
    },
  },
});
