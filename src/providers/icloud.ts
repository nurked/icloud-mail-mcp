/**
 * iCloud Mail provider: IMAP (imapflow) for read/organize, SMTP (nodemailer)
 * for sending, MailComposer for building drafts to APPEND.
 *
 * iCloud requires an app-specific password (generated at appleid.apple.com)
 * because every iCloud account has 2FA.
 */
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser, type AddressObject } from "mailparser";
import type {
  Address,
  Credentials,
  ComposeInput,
  FlagChange,
  Mailbox,
  MailProvider,
  MessageFull,
  MessageSummary,
  OutgoingAttachment,
  SearchQuery,
  SpecialUse,
} from "./types.js";

const IMAP_HOST = "imap.mail.me.com";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.mail.me.com";
const SMTP_PORT = 587;

export class ICloudProvider implements MailProvider {
  readonly id = "icloud";
  private imap: ImapFlow;
  private creds: Credentials;
  private roleCache: Map<SpecialUse, string> | null = null;

  constructor(creds: Credentials) {
    this.creds = creds;
    this.imap = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: creds.email, pass: creds.password },
      logger: false, // keep stdout clean for the MCP stdio transport
    });
  }

  async connect(): Promise<void> {
    if (!this.imap.usable) await this.imap.connect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.imap.logout();
    } catch {
      /* ignore */
    }
  }

  /** Run `fn` with `mailbox` open under an exclusive lock, then release. */
  private async withMailbox<T>(
    mailbox: string,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.connect();
    const lock = await this.imap.getMailboxLock(mailbox);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  // --- Mailboxes & special-use resolution ---

  async listMailboxes(): Promise<Mailbox[]> {
    await this.connect();
    const boxes = await this.imap.list();
    return boxes.map((b) => ({
      path: b.path,
      name: b.name,
      role: roleFromSpecialUse(b.specialUse),
    }));
  }

  private async resolveRole(role: SpecialUse): Promise<string> {
    if (!this.roleCache) {
      this.roleCache = new Map();
      const boxes = await this.imap.list();
      for (const b of boxes) {
        const r = roleFromSpecialUse(b.specialUse);
        if (r) this.roleCache.set(r, b.path);
      }
    }
    const path = this.roleCache.get(role);
    if (path) return path;
    // Sensible iCloud fallbacks if the server didn't advertise SPECIAL-USE.
    const fallback: Record<SpecialUse, string> = {
      inbox: "INBOX",
      sent: "Sent Messages",
      drafts: "Drafts",
      trash: "Deleted Messages",
      junk: "Junk",
      archive: "Archive",
    };
    return fallback[role];
  }

  // --- Read & search ---

  async search(query: SearchQuery): Promise<MessageSummary[]> {
    const mailbox = query.mailbox ?? "INBOX";
    const limit = query.limit ?? 25;
    return this.withMailbox(mailbox, async () => {
      const criteria: Record<string, unknown> = {};
      if (query.from) criteria.from = query.from;
      if (query.to) criteria.to = query.to;
      if (query.subject) criteria.subject = query.subject;
      if (query.text) criteria.text = query.text;
      if (query.since) criteria.since = new Date(query.since);
      if (query.before) criteria.before = new Date(query.before);
      if (query.unreadOnly) criteria.seen = false;
      if (Object.keys(criteria).length === 0) criteria.all = true;

      const uids = (await this.imap.search(criteria, { uid: true })) || [];
      const newest = uids.sort((a, b) => b - a).slice(0, limit);
      if (newest.length === 0) return [];

      const out: MessageSummary[] = [];
      for await (const msg of this.imap.fetch(
        newest,
        { uid: true, flags: true, envelope: true, bodyStructure: true },
        { uid: true }
      )) {
        out.push(summaryFrom(msg, mailbox));
      }
      // fetch order isn't guaranteed; restore newest-first.
      return out.sort((a, b) => b.uid - a.uid);
    });
  }

  async getMessage(mailbox: string, uid: number): Promise<MessageFull> {
    return this.withMailbox(mailbox, async () => {
      const msg = await this.imap.fetchOne(
        String(uid),
        { uid: true, flags: true, envelope: true, source: true },
        { uid: true }
      );
      if (!msg || !msg.source) {
        throw new Error(`Message uid ${uid} not found in ${mailbox}`);
      }
      const parsed = await simpleParser(msg.source);
      const base = summaryFrom(msg, mailbox);
      return {
        ...base,
        cc: toAddresses(parsed.cc),
        bcc: toAddresses(parsed.bcc),
        textBody: parsed.text || undefined,
        htmlBody: typeof parsed.html === "string" ? parsed.html : undefined,
        inReplyTo: parsed.inReplyTo || undefined,
        references: normalizeRefs(parsed.references),
        attachments: parsed.attachments.map((a, i) => ({
          id: String(i),
          filename: a.filename || `attachment-${i}`,
          contentType: a.contentType || "application/octet-stream",
          size: a.size ?? a.content?.length ?? 0,
        })),
      };
    });
  }

  async getThread(mailbox: string, uid: number): Promise<MessageSummary[]> {
    const root = await this.getMessage(mailbox, uid);
    // Collect the Message-IDs that tie the thread together.
    const ids = new Set<string>(root.references);
    if (root.messageId) ids.add(root.messageId);
    if (root.inReplyTo) ids.add(root.inReplyTo);

    return this.withMailbox(mailbox, async () => {
      const found = new Map<number, MessageSummary>();
      found.set(root.uid, root);
      for (const id of ids) {
        const uids =
          (await this.imap.search(
            { header: { "message-id": id } } as never,
            { uid: true }
          )) || [];
        const related =
          (await this.imap.search({ header: { references: id } } as never, {
            uid: true,
          })) || [];
        const all = [...uids, ...related];
        if (all.length === 0) continue;
        for await (const msg of this.imap.fetch(
          all,
          { uid: true, flags: true, envelope: true, bodyStructure: true },
          { uid: true }
        )) {
          found.set(msg.uid, summaryFrom(msg, mailbox));
        }
      }
      return [...found.values()].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );
    });
  }

  async downloadAttachment(
    mailbox: string,
    uid: number,
    attachmentId: string
  ): Promise<{ filename: string; contentType: string; content: Buffer }> {
    return this.withMailbox(mailbox, async () => {
      const msg = await this.imap.fetchOne(
        String(uid),
        { uid: true, source: true },
        { uid: true }
      );
      if (!msg || !msg.source) {
        throw new Error(`Message uid ${uid} not found in ${mailbox}`);
      }
      const parsed = await simpleParser(msg.source);
      const idx = Number(attachmentId);
      const att = parsed.attachments[idx];
      if (!att) throw new Error(`Attachment ${attachmentId} not found`);
      return {
        filename: att.filename || `attachment-${idx}`,
        contentType: att.contentType || "application/octet-stream",
        content: att.content,
      };
    });
  }

  // --- Send & reply ---

  private smtp() {
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: { user: this.creds.email, pass: this.creds.password },
    });
  }

  private mailOptions(input: ComposeInput) {
    return {
      from: this.creds.email, // iCloud requires From to be the account address
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments: (input.attachments ?? []).map(toNodemailerAttachment),
    };
  }

  async sendEmail(input: ComposeInput): Promise<{ messageId: string }> {
    const info = await this.smtp().sendMail(this.mailOptions(input));
    return { messageId: info.messageId };
  }

  async saveDraft(
    input: ComposeInput
  ): Promise<{ mailbox: string; uid?: number }> {
    const draftsBox = await this.resolveRole("drafts");
    const raw = await new Promise<Buffer>((resolve, reject) => {
      new MailComposer(this.mailOptions(input)).compile().build((err, msg) =>
        err ? reject(err) : resolve(msg)
      );
    });
    const res = await this.imap.append(draftsBox, raw, ["\\Draft"]);
    return { mailbox: draftsBox, uid: res ? res.uid : undefined };
  }

  // --- Organize ---

  async moveMessage(
    mailbox: string,
    uid: number,
    targetMailbox: string
  ): Promise<void> {
    await this.withMailbox(mailbox, async () => {
      await this.imap.messageMove(String(uid), targetMailbox, { uid: true });
    });
  }

  async setFlags(
    mailbox: string,
    uid: number,
    flags: FlagChange
  ): Promise<void> {
    await this.withMailbox(mailbox, async () => {
      const add: string[] = [];
      const remove: string[] = [];
      if (flags.seen === true) add.push("\\Seen");
      if (flags.seen === false) remove.push("\\Seen");
      if (flags.flagged === true) add.push("\\Flagged");
      if (flags.flagged === false) remove.push("\\Flagged");
      if (add.length)
        await this.imap.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length)
        await this.imap.messageFlagsRemove(String(uid), remove, { uid: true });
    });
  }

  async archive(mailbox: string, uid: number): Promise<void> {
    const target = await this.resolveRole("archive");
    await this.moveMessage(mailbox, uid, target);
  }

  async deleteMessage(mailbox: string, uid: number): Promise<void> {
    const trash = await this.resolveRole("trash");
    // If it's already in Trash, expunge it; otherwise move it there.
    if (mailbox === trash) {
      await this.withMailbox(mailbox, async () => {
        await this.imap.messageDelete(String(uid), { uid: true });
      });
    } else {
      await this.moveMessage(mailbox, uid, trash);
    }
  }
}

// --- Helpers ---

function roleFromSpecialUse(su?: string): SpecialUse | undefined {
  switch (su) {
    case "\\Inbox":
      return "inbox";
    case "\\Sent":
      return "sent";
    case "\\Drafts":
      return "drafts";
    case "\\Trash":
      return "trash";
    case "\\Junk":
      return "junk";
    case "\\Archive":
      return "archive";
    default:
      return undefined;
  }
}

type FetchedMessage = {
  uid: number;
  flags?: Set<string>;
  envelope?: {
    date?: Date;
    subject?: string;
    from?: { name?: string; address?: string }[];
    to?: { name?: string; address?: string }[];
    messageId?: string;
  };
  bodyStructure?: unknown;
};

function summaryFrom(msg: FetchedMessage, mailbox: string): MessageSummary {
  const env = msg.envelope ?? {};
  const flags = msg.flags ?? new Set<string>();
  return {
    uid: msg.uid,
    mailbox,
    from: (env.from ?? []).map(envAddr),
    to: (env.to ?? []).map(envAddr),
    subject: env.subject ?? "(no subject)",
    date: (env.date ?? new Date(0)).toISOString(),
    unread: !flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    hasAttachments: structureHasAttachment(msg.bodyStructure),
    messageId: env.messageId,
  };
}

function envAddr(a: { name?: string; address?: string }): Address {
  return { name: a.name || undefined, address: a.address ?? "" };
}

function structureHasAttachment(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as {
    disposition?: string;
    childNodes?: unknown[];
  };
  if (n.disposition && n.disposition.toLowerCase() === "attachment") return true;
  if (Array.isArray(n.childNodes)) {
    return n.childNodes.some((c) => structureHasAttachment(c));
  }
  return false;
}

function toAddresses(a?: AddressObject | AddressObject[]): Address[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((group) =>
    group.value.map((v) => ({ name: v.name || undefined, address: v.address ?? "" }))
  );
}

function normalizeRefs(refs?: string | string[]): string[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

function toNodemailerAttachment(a: OutgoingAttachment) {
  if (a.path) return { filename: a.filename, path: a.path, contentType: a.contentType };
  return {
    filename: a.filename,
    content: Buffer.from(a.contentBase64 ?? "", "base64"),
    contentType: a.contentType,
  };
}

/** Build a connected provider from credentials, verifying the login. */
export async function createICloudProvider(
  creds: Credentials
): Promise<ICloudProvider> {
  const p = new ICloudProvider(creds);
  await p.connect();
  return p;
}
