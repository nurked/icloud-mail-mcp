#!/usr/bin/env node
/**
 * `imail-mcp-setup` — opens the local connect page in the browser and waits
 * for the user to link their iCloud account.
 */
import { execFile } from "node:child_process";
import { runSetup } from "../auth/setup-server.js";

const PORT = Number(process.env.IMAIL_SETUP_PORT) || 4577;
const url = `http://127.0.0.1:${PORT}`;

console.log("\n  imail-mcp setup");
console.log("  ----------------");
console.log(`  Opening ${url} in your browser…`);
console.log("  (If it doesn't open, paste that URL in manually.)\n");

// macOS: `open`. Fall back silently if unavailable.
execFile("open", [url], (err) => {
  if (err) console.log(`  Could not auto-open a browser — visit ${url}\n`);
});

runSetup(PORT)
  .then(() => {
    console.log("\n  ✅ iCloud account connected and saved to your Keychain.\n");
    console.log("  Next: add this server to Claude's MCP config, e.g.:\n");
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            imail: { command: "imail-mcp" },
          },
        },
        null,
        2
      )
        .split("\n")
        .map((l) => "    " + l)
        .join("\n")
    );
    console.log(
      "\n  (Use an absolute path to dist/index.js if imail-mcp isn't on your PATH.)\n"
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n  Setup failed:", err);
    process.exit(1);
  });
