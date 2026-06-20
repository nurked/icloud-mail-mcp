# imail-mcp

> 🇷🇺 **Документация на русском:** [README.ru.md](README.ru.md)

An [MCP](https://modelcontextprotocol.io) server that connects Claude
(Cowork / Claude Code / Claude Desktop) to your email account so it can
**read, search, send, and organize** your mail — directly from a conversation.

**iCloud Mail** is the first supported provider. The internals are written
against a provider-agnostic interface, so Gmail / Microsoft 365 adapters can be
added later without touching a single tool.

---

## Highlights

- 📥 **Read & search** — list folders, search by sender/subject/text/date, read
  full messages and whole threads, download attachments.
- ✉️ **Send & reply** — compose, reply, reply-all, and forward with correct
  threading headers set automatically.
- 🗂️ **Organize** — move, archive, delete, and mark messages read/unread or
  flagged.
- 🔒 **Credentials stay local** — stored in the **macOS Keychain**, never in a
  plaintext file or env var.
- 🛑 **Never sends silently** — Claude is instructed to always preview an email
  and get your explicit approval before anything leaves your outbox.

---

## Why a one-time setup (and no "Sign in with Apple" button)

Apple does **not** offer an OAuth / consent flow for third-party access to
iCloud Mail. The only supported path is standard **IMAP + SMTP** with an
**app-specific password** (required because every iCloud account uses 2FA).

So setup is a one-time step: generate that password once, hand it to the server,
done. It is verified with a **live IMAP login** and then stored in your
**macOS Keychain** — not on disk, not in your shell profile.

> **Platform note:** credential storage uses the built-in macOS `security` CLI,
> so the server currently targets **macOS**. (A different keystore backend is
> all that's needed to support Linux/Windows.)

---

## Install & connect

Requires **Node.js ≥ 18**.

```bash
git clone git@github.com:nurked/icloud-mail-mcp.git
cd icloud-mail-mcp
npm install
npm run build
npm run setup          # or: node dist/bin/setup.js
```

`setup` opens a local page at **http://127.0.0.1:4577** (bound to localhost
only — never exposed off your machine). The page:

1. Links you to Apple's app-specific password page.
2. Takes your iCloud address + the 16-character password you generate.
3. Does a **live IMAP test login** to verify it works.
4. Saves the credentials to your **Keychain**.

### Generating the app-specific password

1. Open [appleid.apple.com](https://appleid.apple.com/account/manage) →
   **Sign-In and Security → App-Specific Passwords**.
2. Click **Generate an app-specific password**, name it `imail-mcp`.
3. Copy the 16-character password and paste it into the setup page.

---

## Wire it into Claude

Add the server to your MCP config (Claude Desktop / Cowork / Claude Code
`mcpServers`):

```json
{
  "mcpServers": {
    "imail": {
      "command": "node",
      "args": ["/absolute/path/to/icloud-mail-mcp/dist/index.js"]
    }
  }
}
```

> If you install the package globally (`npm link` or `npm i -g`), you can use
> `"command": "imail-mcp"` with no `args` instead.

Restart Claude and the `imail` tools become available.

---

## Tools

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | List folders with their IMAP paths and special-use roles |
| `search_messages` | Search by from / to / subject / text / date / unread (filters AND together) |
| `get_message` | Full headers, text + HTML body, attachment metadata |
| `get_thread` | The whole conversation, oldest → newest |
| `download_attachment` | Save an attachment to a temp file, return its path |
| `compose_preview` | Build an email for review — **does not send** |
| `send_email` | Send now (only after your approval) |
| `save_draft` | Put it in Drafts for you to send yourself |
| `reply` | Reply / reply-all, threading headers set from the original |
| `forward` | Forward to new recipients with a quoted header |
| `move_message` | Move a message to another mailbox |
| `set_flags` | Mark read/unread, flag/unflag |
| `archive_message` | Move to Archive |
| `delete_message` | Move to Trash (expunge if already there) |

### Sending is never silent

The server ships an instruction telling Claude to **always** show you a
`compose_preview` and get your explicit go-ahead before calling `send_email`
(or `reply` / `forward`). If you'd rather send it yourself, ask Claude to
`save_draft` instead and the message lands in your Drafts folder.

---

## How it works

```
Claude  ──stdio──▶  imail-mcp  ──IMAP (imap.mail.me.com:993)──▶  iCloud
                       │        └─SMTP (smtp.mail.me.com:587)──▶  iCloud
                       └─ credentials ◀── macOS Keychain
```

- **IMAP** ([imapflow](https://www.npmjs.com/package/imapflow)) handles reading
  and organizing; **SMTP** ([nodemailer](https://nodemailer.com)) handles
  sending; bodies are parsed with
  [mailparser](https://www.npmjs.com/package/mailparser).
- The provider connects **lazily** on the first tool call, so adding the server
  to Claude doesn't touch your mailbox until you actually use it.
- The MCP `stdio` transport owns stdout, so all logging goes to stderr to keep
  the protocol stream clean.

### Project layout

```
src/
  index.ts              MCP server + tool definitions
  bin/setup.ts          `imail-mcp-setup` entry point
  auth/
    setup-server.ts     local connect page + live IMAP verification
    keychain.ts         macOS Keychain storage (via `security` CLI)
  providers/
    types.ts            provider-agnostic MailProvider contract
    icloud.ts           iCloud IMAP/SMTP implementation
```

---

## Adding another provider

The tools only ever talk to the `MailProvider` interface, so a new backend is
one new file:

1. Implement `MailProvider` (see
   [`src/providers/types.ts`](src/providers/types.ts)) in a new file under
   `src/providers/`.
2. Select it in [`src/index.ts`](src/index.ts).

The tools stay unchanged.

---

## Troubleshooting

- **"No iCloud credentials found"** — run `npm run setup` first; the server
  reads from the Keychain on first tool use.
- **"Login failed"** during setup — make sure you used an **app-specific
  password**, not your normal Apple ID password.
- **Re-connecting / changing accounts** — just run `npm run setup` again; it
  overwrites the stored credentials (`-U` update) after a fresh verification.

---

## License

**[PolyForm Noncommercial License 1.0.0](LICENSE.md)** — this is *source-available*,
not OSI open source.

- ✅ **Free** for any **noncommercial** purpose — personal use, study, research,
  hobby projects, and use by nonprofits, schools, and government bodies.
- ✅ You may read, modify, and redistribute it; the **copyright notice must stay
  intact**, so your work is always credited.
- 💼 **Commercial use requires a separate license.** If you want to use imail-mcp
  to make money — in a product, a paid service, or inside a for-profit company —
  contact Investment Fidelity Company at **ceo@investmentfidelity.company** to
  arrange a commercial license.

See [LICENSE.md](LICENSE.md) for the full terms.
