/**
 * Local setup web server. Serves a one-page form where the user pastes their
 * iCloud address + app-specific password. On submit it does a live IMAP test
 * login, then stores the credentials in the macOS Keychain.
 *
 * Bound to 127.0.0.1 only — never exposed off the machine.
 */
import { createServer, type IncomingMessage } from "node:http";
import { ICloudProvider } from "../providers/icloud.js";
import { saveCredentials } from "./keychain.js";

const PROVIDER_ID = "icloud";

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect iCloud Mail · imail-mcp</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 540px;
         margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 22px; }
  ol { padding-left: 20px; } li { margin: 6px 0; }
  label { display: block; margin: 16px 0 4px; font-weight: 600; }
  input { width: 100%; padding: 10px; font-size: 16px; border: 1px solid #8884;
          border-radius: 8px; box-sizing: border-box; }
  button { margin-top: 20px; padding: 11px 18px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 8px; background: #0a84ff; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .a { display: inline-block; margin: 8px 0; }
  #msg { margin-top: 18px; padding: 12px; border-radius: 8px; display: none; }
  #msg.ok { display: block; background: #34c75922; }
  #msg.err { display: block; background: #ff3b3022; }
  code { background: #8881; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>Connect iCloud Mail</h1>
  <p>iCloud needs an <strong>app-specific password</strong> (your normal Apple
     password won't work with mail apps).</p>
  <ol>
    <li>Open <a class="a" href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener">appleid.apple.com → Sign-In and Security → App-Specific Passwords</a></li>
    <li>Click <em>Generate an app-specific password</em>, name it "imail-mcp".</li>
    <li>Copy the 16-character password it shows and paste it below.</li>
  </ol>
  <form id="f">
    <label for="email">iCloud email address</label>
    <input id="email" name="email" type="email" placeholder="you@icloud.com" required autocomplete="off" />
    <label for="password">App-specific password</label>
    <input id="password" name="password" type="password" placeholder="xxxx-xxxx-xxxx-xxxx" required autocomplete="off" />
    <button id="btn" type="submit">Connect &amp; verify</button>
  </form>
  <div id="msg"></div>
<script>
  const f = document.getElementById('f');
  const btn = document.getElementById('btn');
  const msg = document.getElementById('msg');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = 'Verifying…';
    msg.className = ''; msg.textContent = '';
    const body = new URLSearchParams(new FormData(f)).toString();
    try {
      const r = await fetch('/connect', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const data = await r.json();
      if (r.ok) {
        msg.className = 'ok';
        msg.innerHTML = '✅ Connected as <code>' + data.email + '</code>. ' +
          'Credentials saved to your Keychain. You can close this tab — see the terminal for the next step.';
        f.style.display = 'none';
      } else {
        msg.className = 'err';
        msg.textContent = '❌ ' + (data.error || 'Could not connect.');
      }
    } catch (err) {
      msg.className = 'err'; msg.textContent = '❌ ' + err;
    } finally {
      btn.disabled = false; btn.textContent = 'Connect & verify';
    }
  });
</script>
</body>
</html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // basic guard
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Starts the setup server. Resolves once the user has connected successfully
 * (so the caller can print next steps and exit).
 */
export function runSetup(port = 4577): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }

      if (req.method === "POST" && req.url === "/connect") {
        try {
          const params = new URLSearchParams(await readBody(req));
          const email = (params.get("email") || "").trim();
          const password = (params.get("password") || "").replace(/\s+/g, "");
          if (!email || !password) throw new Error("Email and password are required.");

          // Live verification: connect over IMAP, then disconnect.
          const provider = new ICloudProvider({ email, password });
          await provider.connect();
          await provider.disconnect();

          await saveCredentials(PROVIDER_ID, { email, password });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, email }));

          // Give the response a moment to flush, then finish.
          setTimeout(() => {
            server.close();
            resolve();
          }, 300);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Connection failed.";
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                /auth/i.test(message) || /login/i.test(message)
                  ? "Login failed — double-check the email and app-specific password."
                  : message,
            })
          );
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      // Caller logs the URL / opens the browser.
    });
  });
}
