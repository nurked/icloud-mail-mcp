/**
 * Provider-agnostic mail contract.
 *
 * Every backend (iCloud today; Gmail / M365 later) implements MailProvider.
 * The MCP tools in src/index.ts only ever talk to this interface, so adding a
 * new provider is one new file under src/providers/ — no tool changes.
 */

export interface Credentials {
  /** Full email address, used as the SMTP/IMAP username and the From address. */
  email: string;
  /** App-specific password (iCloud) or provider password/token. */
  password: string;
}

export interface Mailbox {
  /** IMAP path, e.g. "INBOX" or "Archive". Use this in other calls. */
  path: string;
  /** Human-friendly leaf name. */
  name: string;
  /** Special-use role if known: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive'. */
  role?: SpecialUse;
}

export type SpecialUse = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive";

export interface Address {
  name?: string;
  address: string;
}

export interface MessageSummary {
  uid: number;
  mailbox: string;
  from: Address[];
  to: Address[];
  subject: string;
  /** ISO 8601 date. */
  date: string;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  messageId?: string;
}

export interface AttachmentMeta {
  /** Stable id within this message (index-based). Pass to downloadAttachment. */
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MessageFull extends MessageSummary {
  cc: Address[];
  bcc: Address[];
  textBody?: string;
  htmlBody?: string;
  inReplyTo?: string;
  references: string[];
  attachments: AttachmentMeta[];
}

export interface SearchQuery {
  /** Mailbox to search; defaults to INBOX. */
  mailbox?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** Free-text match across the message. */
  text?: string;
  /** ISO date — messages on/after this date. */
  since?: string;
  /** ISO date — messages before this date. */
  before?: string;
  unreadOnly?: boolean;
  /** Max results, newest first. Default 25. */
  limit?: number;
}

export interface OutgoingAttachment {
  filename: string;
  /** Either an absolute file path... */
  path?: string;
  /** ...or inline base64 content. */
  contentBase64?: string;
  contentType?: string;
}

export interface ComposeInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  /** Message-ID this is a reply to (sets In-Reply-To / References headers). */
  inReplyTo?: string;
  references?: string[];
}

export interface FlagChange {
  /** true = mark read, false = mark unread, undefined = leave as-is. */
  seen?: boolean;
  /** true = flag/star, false = unflag, undefined = leave as-is. */
  flagged?: boolean;
}

export interface MailProvider {
  readonly id: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // --- Read & search ---
  listMailboxes(): Promise<Mailbox[]>;
  search(query: SearchQuery): Promise<MessageSummary[]>;
  getMessage(mailbox: string, uid: number): Promise<MessageFull>;
  getThread(mailbox: string, uid: number): Promise<MessageSummary[]>;
  downloadAttachment(
    mailbox: string,
    uid: number,
    attachmentId: string
  ): Promise<{ filename: string; contentType: string; content: Buffer }>;

  // --- Send & reply ---
  sendEmail(input: ComposeInput): Promise<{ messageId: string }>;
  saveDraft(input: ComposeInput): Promise<{ mailbox: string; uid?: number }>;

  // --- Organize ---
  moveMessage(mailbox: string, uid: number, targetMailbox: string): Promise<void>;
  setFlags(mailbox: string, uid: number, flags: FlagChange): Promise<void>;
  archive(mailbox: string, uid: number): Promise<void>;
  /** Moves to Trash rather than hard-expunging. */
  deleteMessage(mailbox: string, uid: number): Promise<void>;
}
