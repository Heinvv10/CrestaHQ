import "server-only";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import ipaddr from "ipaddr.js";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import type { SmtpConnection } from "@/types/email";
import type { MailboxConnection, MailboxMeta } from "@/types/mailbox";
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
export class MailboxError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
export function mailboxPublicError(error: unknown): MailboxError {
  return error instanceof MailboxError
    ? error
    : new MailboxError(
        "Mailbox connection or sync failed. Check your IMAP settings and try again.",
        502
      );
}
export function mailboxMetadata(c: MailboxMeta): MailboxMeta {
  const {
    host,
    port,
    username,
    sentFolder,
    verifiedAt,
    lastSyncAt,
    lastError,
    enabled,
  } = c;
  return {
    host,
    port,
    username,
    sentFolder,
    verifiedAt,
    lastSyncAt,
    lastError,
    enabled,
  };
}
export function validateMailboxInput(
  value: unknown,
  smtp?: SmtpConnection
): MailboxConnection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MailboxError("Invalid mailbox settings.");
  const b = value as Record<string, unknown>;
  const str = (key: string, max: number, optional = false) => {
    const v = b[key] ?? (optional ? "" : undefined);
    if (
      typeof v !== "string" ||
      v.length > max ||
      /[\x00-\x1f\x7f]/.test(v) ||
      (!optional && !v.trim())
    )
      throw new MailboxError(`Invalid ${key}.`);
    return key === "password" ? v : v.trim();
  };
  const host = str("host", 253).toLowerCase(),
    username = str("username", 320);
  if (
    !host
      .split(".")
      .every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))
  )
    throw new MailboxError("Invalid IMAP hostname.");
  if (b.port !== 993) throw new MailboxError("IMAP requires TLS on port 993.");
  if (typeof b.useSmtpCredentials !== "boolean")
    throw new MailboxError("Choose whether to reuse SMTP credentials.");
  let password = str("password", 4096, true);
  if (b.useSmtpCredentials) {
    if (!smtp || smtp.host !== host || smtp.username !== username)
      throw new MailboxError(
        "SMTP reuse requires this account’s matching host and username."
      );
    password = smtp.password;
  }
  if (!password) throw new MailboxError("Enter your mailbox password.");
  return {
    host,
    port: 993,
    username,
    password,
    sentFolder: str("sentFolder", 500, true) || null,
    verifiedAt: "",
    lastSyncAt: null,
    lastError: null,
    enabled: true,
    version: randomUUID(),
    ownAddresses: [username, ...(smtp?.fromEmail ? [smtp.fromEmail] : [])].map(
      (a) => a.toLowerCase()
    ),
    initialSince: new Date(Date.now() - 30 * 86400000).toISOString(),
    cursors: {},
    leaseToken: null,
    leaseUntil: 0,
  };
}
export async function resolveMailboxHost(host: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new MailboxError("IMAP hostname lookup timed out.", 502)),
          10000
        );
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some(
        ({ address }) =>
          !ipaddr.isValid(address) ||
          ipaddr.parse(address).range() !== "unicast"
      )
    )
      throw new MailboxError(
        "IMAP host must resolve only to public IP addresses."
      );
    return addresses[0].address;
  } finally {
    clearTimeout(timer);
  }
}
export async function connectMailbox(c: MailboxConnection): Promise<ImapFlow> {
  const host = await resolveMailboxHost(c.host);
  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    servername: c.host,
    auth: { user: c.username, pass: c.password },
    tls: {
      servername: c.host,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  client.on("error", () => {}); // Worker reports only sanitized errors; no protocol/credential logging.
  try {
    await client.connect();
    return client;
  } catch (error) {
    client.close();
    throw mailboxPublicError(error);
  }
}
export function discoverSentFolder(
  folders: { path: string; specialUse?: string }[],
  override?: string | null
): string | null {
  if (override) {
    if (!folders.some((f) => f.path === override))
      throw new MailboxError("The selected Sent folder does not exist.");
    return override;
  }
  return folders.find((f) => f.specialUse === "\\Sent")?.path ?? null;
}
export async function verifyMailboxConnection(
  c: MailboxConnection
): Promise<void> {
  const client = await connectMailbox(c);
  const timer = setTimeout(() => client.close(), 25000);
  try {
    c.sentFolder = discoverSentFolder(await client.list(), c.sentFolder);
    for (const folder of new Set([
      "INBOX",
      ...(c.sentFolder ? [c.sentFolder] : []),
    ])) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      lock.release();
    }
    c.verifiedAt = new Date().toISOString();
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
function addresses(
  value: AddressObject | AddressObject[] | undefined
): string[] {
  const flatten = (
    rows: { address?: string; group?: { address?: string }[] }[]
  ): string[] =>
    rows.flatMap((v) =>
      v.address ? [v.address.toLowerCase()] : v.group ? flatten(v.group) : []
    );
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((a) =>
    flatten(a.value)
  );
}
export async function parseMailboxMessage(source: Buffer) {
  if (source.length > MAX_MESSAGE_BYTES)
    throw new MailboxError("Message exceeds the 5 MB import limit.");
  const mail = await simpleParser(source, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
    maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
  });
  return {
    from: addresses(mail.from)[0] ?? "",
    to: [
      ...new Set([
        ...addresses(mail.to),
        ...addresses(mail.cc),
        ...addresses(mail.bcc),
      ]),
    ],
    subject: mail.subject ?? "",
    body: (mail.text ?? "").slice(0, 100000),
    messageId:
      mail.messageId ??
      `<mailbox-${createHash("sha256").update(source).digest("hex")}@import.local>`,
    inReplyTo: mail.inReplyTo ?? null,
    references:
      typeof mail.references === "string"
        ? [mail.references]
        : (mail.references ?? []),
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.contentType,
      size: a.size,
    })),
    date: mail.date,
    archive: mail.headers.get("x-crestahq-archive") !== "no",
  };
}
