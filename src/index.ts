#!/usr/bin/env node
/**
 * imail-mcp — MCP server exposing an email account to Claude.
 *
 * Reads credentials from the macOS Keychain (run `imail-mcp-setup` first),
 * connects the iCloud provider lazily on first tool use, and exposes
 * read / send / organize tools over the stdio transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials } from "./auth/keychain.js";
import { ICloudProvider } from "./providers/icloud.js";
import type { ComposeInput, MailProvider } from "./providers/types.js";

const PROVIDER_ID = "icloud";

let providerPromise: Promise<MailProvider> | null = null;
async function getProvider(): Promise<MailProvider> {
  if (!providerPromise) {
    providerPromise = (async () => {
      const creds = await loadCredentials(PROVIDER_ID);
      if (!creds) {
        throw new Error(
          "No iCloud credentials found. Run `imail-mcp-setup` to connect your account."
        );
      }
      const p = new ICloudProvider(creds);
      await p.connect();
      return p;
    })().catch((e) => {
      providerPromise = null; // allow retry after a failed connect
      throw e;
    });
  }
  return providerPromise;
}

/** Wrap a handler so thrown errors come back as MCP tool errors, not crashes. */
function tool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text" as const, text: jsonText(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${message}` }],
      };
    }
  };
}

function jsonText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

const server = new McpServer(
  { name: "imail-mcp", version: "0.1.0" },
  {
    instructions: [
      "This server connects to the user's email account (iCloud).",
      "",
      "SENDING DISCIPLINE — follow exactly:",
      "- NEVER call `send_email`, `reply`, or `forward` without the user's explicit go-ahead in the conversation.",
      "- When the user asks you to write an email, FIRST call `compose_preview` and show them the result. Only call `send_email` after they say to send it.",
      "- If the user says to save it for later / send it themselves, use `save_draft` instead — it puts the message in their Drafts folder.",
      "",
      "Use `list_mailboxes` to discover folder paths. UIDs are per-mailbox; always pass the mailbox a message came from.",
    ].join("\n"),
  }
);

// ----- Read & search -----

server.registerTool(
  "list_mailboxes",
  {
    title: "List mailboxes",
    description: "List all mailboxes/folders with their IMAP paths and roles.",
    inputSchema: {},
  },
  tool(async () => (await getProvider()).listMailboxes())
);

server.registerTool(
  "search_messages",
  {
    title: "Search messages",
    description:
      "Search a mailbox. All filters are optional and combined with AND. Returns summaries, newest first.",
    inputSchema: {
      mailbox: z.string().optional().describe('Mailbox path; default "INBOX".'),
      from: z.string().optional().describe("Match sender."),
      to: z.string().optional().describe("Match recipient."),
      subject: z.string().optional().describe("Match subject."),
      text: z.string().optional().describe("Free-text match in the message."),
      since: z.string().optional().describe("ISO date — on/after."),
      before: z.string().optional().describe("ISO date — before."),
      unreadOnly: z.boolean().optional().describe("Only unread messages."),
      limit: z.number().int().positive().max(200).optional().describe("Max results (default 25)."),
    },
  },
  tool(async (args) => (await getProvider()).search(args))
);

server.registerTool(
  "get_message",
  {
    title: "Get message",
    description:
      "Fetch a full message: headers, text + HTML body, and attachment metadata.",
    inputSchema: {
      mailbox: z.string().describe("Mailbox the message is in."),
      uid: z.number().int().describe("Message UID within that mailbox."),
    },
  },
  tool(async ({ mailbox, uid }) => (await getProvider()).getMessage(mailbox, uid))
);

server.registerTool(
  "get_thread",
  {
    title: "Get thread",
    description:
      "Fetch the conversation a message belongs to, ordered oldest to newest.",
    inputSchema: {
      mailbox: z.string(),
      uid: z.number().int(),
    },
  },
  tool(async ({ mailbox, uid }) => (await getProvider()).getThread(mailbox, uid))
);

server.registerTool(
  "download_attachment",
  {
    title: "Download attachment",
    description:
      "Save an attachment to a local temp file and return its path. Get the attachmentId from get_message.",
    inputSchema: {
      mailbox: z.string(),
      uid: z.number().int(),
      attachmentId: z.string().describe("Attachment id from get_message."),
    },
  },
  tool(async ({ mailbox, uid, attachmentId }) => {
    const att = await (await getProvider()).downloadAttachment(
      mailbox,
      uid,
      attachmentId
    );
    const dir = await mkdtemp(join(tmpdir(), "imail-"));
    const path = join(dir, att.filename);
    await writeFile(path, att.content);
    return { path, filename: att.filename, contentType: att.contentType, size: att.content.length };
  })
);

// ----- Send & reply -----

const composeShape = {
  to: z.array(z.string()).describe("Recipient email addresses."),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  text: z.string().optional().describe("Plain-text body."),
  html: z.string().optional().describe("HTML body."),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        path: z.string().optional().describe("Absolute path to a local file."),
        contentBase64: z.string().optional().describe("Inline base64 content."),
        contentType: z.string().optional(),
      })
    )
    .optional(),
  inReplyTo: z.string().optional().describe("Message-ID being replied to."),
  references: z.array(z.string()).optional(),
};

server.registerTool(
  "compose_preview",
  {
    title: "Compose preview (does NOT send)",
    description:
      "Build an email and return it for the user to review. Does not send or save anything. Use this first, then send_email after the user approves.",
    inputSchema: composeShape,
  },
  tool(async (args: ComposeInput) => ({
    preview: {
      to: args.to,
      cc: args.cc ?? [],
      bcc: args.bcc ?? [],
      subject: args.subject,
      body: args.text ?? args.html ?? "",
      attachments: (args.attachments ?? []).map((a) => a.filename),
    },
    note: "Nothing was sent. Call send_email with the same fields once the user approves, or save_draft to put it in Drafts.",
  }))
);

server.registerTool(
  "send_email",
  {
    title: "Send email",
    description:
      "Send an email NOW. Only call after the user has explicitly approved sending (ideally after a compose_preview).",
    inputSchema: composeShape,
  },
  tool(async (args: ComposeInput) => (await getProvider()).sendEmail(args))
);

server.registerTool(
  "save_draft",
  {
    title: "Save draft",
    description:
      "Save an email to the Drafts mailbox so the user can review and send it themselves. Does not send.",
    inputSchema: composeShape,
  },
  tool(async (args: ComposeInput) => (await getProvider()).saveDraft(args))
);

server.registerTool(
  "reply",
  {
    title: "Reply to a message",
    description:
      "Reply to an existing message. Set replyAll for reply-all. Like send_email, only call after explicit user approval. Threading headers are set automatically from the original.",
    inputSchema: {
      mailbox: z.string(),
      uid: z.number().int(),
      replyAll: z.boolean().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
      attachments: composeShape.attachments,
    },
  },
  tool(async ({ mailbox, uid, replyAll, text, html, attachments }) => {
    const p = await getProvider();
    const orig = await p.getMessage(mailbox, uid);
    const to = orig.from.map((a) => a.address).filter(Boolean);
    const cc = replyAll
      ? orig.to.concat(orig.cc).map((a) => a.address).filter((a) => a)
      : undefined;
    const subject = orig.subject.match(/^re:/i)
      ? orig.subject
      : `Re: ${orig.subject}`;
    const references = [...orig.references];
    if (orig.messageId) references.push(orig.messageId);
    return p.sendEmail({
      to,
      cc,
      subject,
      text,
      html,
      attachments,
      inReplyTo: orig.messageId,
      references,
    });
  })
);

server.registerTool(
  "forward",
  {
    title: "Forward a message",
    description:
      "Forward an existing message to new recipients. Only call after explicit user approval.",
    inputSchema: {
      mailbox: z.string(),
      uid: z.number().int(),
      to: z.array(z.string()),
      cc: z.array(z.string()).optional(),
      note: z.string().optional().describe("Optional note to prepend."),
    },
  },
  tool(async ({ mailbox, uid, to, cc, note }) => {
    const p = await getProvider();
    const orig = await p.getMessage(mailbox, uid);
    const header =
      `---------- Forwarded message ----------\n` +
      `From: ${orig.from.map(fmtAddr).join(", ")}\n` +
      `Date: ${orig.date}\n` +
      `Subject: ${orig.subject}\n` +
      `To: ${orig.to.map(fmtAddr).join(", ")}\n\n`;
    const body = (note ? note + "\n\n" : "") + header + (orig.textBody ?? "");
    return p.sendEmail({
      to,
      cc,
      subject: orig.subject.match(/^fwd:/i) ? orig.subject : `Fwd: ${orig.subject}`,
      text: body,
    });
  })
);

// ----- Organize -----

server.registerTool(
  "move_message",
  {
    title: "Move message",
    description: "Move a message to another mailbox.",
    inputSchema: {
      mailbox: z.string(),
      uid: z.number().int(),
      targetMailbox: z.string(),
    },
  },
  tool(async ({ mailbox, uid, targetMailbox }) => {
    await (await getProvider()).moveMessage(mailbox, uid, targetMailbox);
    return { moved: true, uid, to: targetMailbox };
  })
);

server.registerTool(
  "set_flags",
  {
    title: "Set flags",
    description: "Mark a message read/unread and/or flagged/unflagged.",
    inputSchema: {
      mailbox: z.string(),
      uid: z.number().int(),
      seen: z.boolean().optional().describe("true=read, false=unread."),
      flagged: z.boolean().optional().describe("true=flag, false=unflag."),
    },
  },
  tool(async ({ mailbox, uid, seen, flagged }) => {
    await (await getProvider()).setFlags(mailbox, uid, { seen, flagged });
    return { ok: true, uid, seen, flagged };
  })
);

server.registerTool(
  "archive_message",
  {
    title: "Archive message",
    description: "Move a message to the Archive mailbox.",
    inputSchema: { mailbox: z.string(), uid: z.number().int() },
  },
  tool(async ({ mailbox, uid }) => {
    await (await getProvider()).archive(mailbox, uid);
    return { archived: true, uid };
  })
);

server.registerTool(
  "delete_message",
  {
    title: "Delete message",
    description:
      "Move a message to Trash (or expunge it if it is already in Trash).",
    inputSchema: { mailbox: z.string(), uid: z.number().int() },
  },
  tool(async ({ mailbox, uid }) => {
    await (await getProvider()).deleteMessage(mailbox, uid);
    return { deleted: true, uid };
  })
);

function fmtAddr(a: { name?: string; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr is safe; stdout is reserved for the MCP protocol.
  console.error("imail-mcp failed to start:", err);
  process.exit(1);
});
