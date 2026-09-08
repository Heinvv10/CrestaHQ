import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import ipaddr from "ipaddr.js";
import { getAdminDb } from "@/lib/firebase/admin";
import type { SmtpConnection, SmtpMeta } from "@/types/email";

export class SmtpError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

export function smtpPublicError(error: unknown): SmtpError {
  if (error instanceof SmtpError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === "EAUTH")
    return new SmtpError(
      "SMTP authentication failed. Check the username and password.",
      502
    );
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET")
    return new SmtpError(
      "SMTP connection failed. Check the host, port and TLS settings.",
      502
    );
  return new SmtpError(
    "SMTP operation failed. Check the provider settings and try again.",
    502
  );
}

export function smtpMetadata(connection: SmtpMeta): SmtpMeta {
  return {
    host: connection.host,
    port: connection.port,
    secure: connection.secure,
    username: connection.username,
    fromEmail: connection.fromEmail,
    fromName: connection.fromName,
    verifiedAt: connection.verifiedAt,
  };
}

export function validEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value) &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

export function validateSmtpInput(
  value: unknown,
  existing?: SmtpConnection | null
): SmtpConnection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SmtpError("Invalid SMTP settings.");
  const body = value as Record<string, unknown>;
  const field = (key: string, max: number, optional = false) => {
    const v = body[key];
    if (
      typeof v !== "string" ||
      v.length > max ||
      /[\x00-\x1f\x7f]/.test(v) ||
      (!optional && !v.trim())
    )
      throw new SmtpError(`Invalid ${key}.`);
    return key === "password" ? v : v.trim();
  };
  const host = field("host", 253).toLowerCase();
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
    host
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new SmtpError("Invalid SMTP hostname.");
  const port = body.port;
  const secure = body.secure;
  if (
    !(
      (port === 465 && secure === true) ||
      ((port === 587 || port === 2525) && secure === false)
    )
  )
    throw new SmtpError("Use TLS on port 465 or STARTTLS on port 587 or 2525.");
  const username = field("username", 320);
  let password = field("password", 4096, true);
  if (
    !password &&
    existing &&
    existing.host === host &&
    existing.port === port &&
    existing.secure === secure &&
    existing.username === username
  )
    password = existing.password;
  if (!password)
    throw new SmtpError(
      "Enter a password when connecting or changing the authentication settings."
    );
  const fromEmail = field("fromEmail", 254);
  if (!validEmail(fromEmail))
    throw new SmtpError("Enter a valid sender email address.");
  return {
    host,
    port,
    secure,
    username,
    password,
    fromEmail,
    fromName: field("fromName", 200, true),
    verifiedAt: "",
  };
}

export async function getSmtpConnection(
  subAccountId: string
): Promise<SmtpConnection> {
  const snap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/private/smtpConnection`)
    .get();
  if (!snap.exists)
    throw new SmtpError(
      "SMTP is not connected. Configure it in Messaging settings.",
      503
    );
  const data = snap.data() as SmtpConnection;
  return { ...validateSmtpInput(data), verifiedAt: data.verifiedAt };
}

async function transport(connection: SmtpConnection) {
  let addresses: { address: string; family: number }[];
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = isIP(connection.host)
      ? [{ address: connection.host, family: isIP(connection.host) }]
      : await Promise.race([
          lookup(connection.host, { all: true }),
          new Promise<never>((_, reject) => {
            dnsTimer = setTimeout(
              () => reject(new Error("DNS timeout")),
              10000
            );
          }),
        ]);
  } catch {
    throw new SmtpError("SMTP hostname could not be resolved.", 502);
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !ipaddr.isValid(address) || ipaddr.parse(address).range() !== "unicast"
    )
  )
    throw new SmtpError("SMTP host must resolve only to public IP addresses.");
  return nodemailer.createTransport({
    host: addresses[0].address,
    port: connection.port,
    secure: connection.secure,
    requireTLS: true,
    forceAuth: true,
    auth: { user: connection.username, pass: connection.password },
    tls: {
      servername: connection.host,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}

export async function verifySmtpConnection(
  connection: SmtpConnection
): Promise<void> {
  const client = await transport(validateSmtpInput(connection));
  try {
    await client.verify();
  } catch (error) {
    throw smtpPublicError(error);
  } finally {
    client.close();
  }
}

export async function sendSmtpEmail(
  connection: SmtpConnection,
  message: {
    archive?: boolean;
    inReplyTo?: string;
    references?: string[];
    to: string;
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    attachments?: { filename: string; content: string; contentType?: string }[];
  }
): Promise<{ id: string }> {
  const ids = [message.inReplyTo, ...(message.references ?? [])].filter(
    (id): id is string => id !== undefined
  );
  if (
    ids.length > 101 ||
    ids.some((id) => id.length > 998 || !/^<[^\s<>]+@[^\s<>]+>$/.test(id))
  )
    throw new SmtpError("Invalid email thread headers.");
  if (
    !validEmail(message.to) ||
    /[\r\n\x00]/.test(message.subject) ||
    (message.replyTo && !validEmail(message.replyTo))
  )
    throw new SmtpError("Invalid email headers.");
  const client = await transport(validateSmtpInput(connection));
  try {
    const result = await client.sendMail({
      from: { name: connection.fromName, address: connection.fromEmail },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
      ...(message.archive === false
        ? { headers: { "X-CrestaHQ-Archive": "no" } }
        : {}),
      inReplyTo: message.inReplyTo,
      references: message.references,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "base64"),
        contentType: a.contentType,
      })),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!result.messageId || !result.accepted?.length)
      throw new SmtpError("SMTP provider did not accept the message.", 502);
    return { id: result.messageId };
  } catch (error) {
    throw smtpPublicError(error);
  } finally {
    client.close();
  }
}
