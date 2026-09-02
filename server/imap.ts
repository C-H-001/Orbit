import { ImapFlow, type ImapFlowOptions, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { extractReadableEmailText } from "./email-content";
import type { RawMailMessage } from "./sync";

interface ImapSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  folder: string;
}

interface ImapClientLike {
  mailbox?: { uidValidity: bigint } | false;
  connect(): Promise<unknown>;
  getMailboxLock(folder: string, options: { readOnly: true }): Promise<{ release(): void }>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false>;
  fetch(
    range: number[],
    query: { uid: true; source: true; envelope: true; internalDate: true },
    options: { uid: true },
  ): AsyncIterable<{ uid: number; source?: Buffer }>;
  logout(): Promise<unknown>;
}

function firstAddress(address: AddressObject | AddressObject[] | undefined) {
  const item = Array.isArray(address) ? address[0] : address;
  return item?.value[0]?.address ?? "";
}

function defaultIncrementalDate() {
  return new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
}

export function createImapMailSource(options: {
  getSettings: () => ImapSettings;
  clientFactory?: (configuration: ImapFlowOptions) => ImapClientLike;
}) {
  const clientFactory = options.clientFactory ?? ((configuration) => new ImapFlow(configuration));

  function createClient() {
    const settings = options.getSettings();
    if (!settings.host.trim()) throw new Error("IMAP host is not configured");
    if (!settings.username.trim()) throw new Error("IMAP username is not configured");
    if (!settings.password) throw new Error("IMAP password is not configured");
    return {
      client: clientFactory({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        auth: { user: settings.username, pass: settings.password },
        logger: false,
        disableAutoIdle: true,
      }),
      settings,
    };
  }

  async function withReadOnlyMailbox<T>(callback: (client: ImapClientLike, settings: ImapSettings) => Promise<T>) {
    const { client, settings } = createClient();
    let connected = false;
    let lock: { release(): void } | undefined;
    try {
      await client.connect();
      connected = true;
      lock = await client.getMailboxLock(settings.folder, { readOnly: true });
      return await callback(client, settings);
    } finally {
      lock?.release();
      if (connected) await client.logout();
    }
  }

  async function* fetchMessages(input: { mode: "incremental" | "backfill"; from?: string }): AsyncGenerator<RawMailMessage> {
    const { client, settings } = createClient();
    let connected = false;
    let lock: { release(): void } | undefined;
    try {
      await client.connect();
      connected = true;
      lock = await client.getMailboxLock(settings.folder, { readOnly: true });
      const since = input.mode === "backfill" && input.from ? input.from : defaultIncrementalDate();
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return;

      const uidValidity = client.mailbox && typeof client.mailbox === "object" ? String(client.mailbox.uidValidity) : "unknown";
      for await (const item of client.fetch(
        uids,
        { uid: true, source: true, envelope: true, internalDate: true },
        { uid: true },
      )) {
        if (!item.source) continue;
        const parsed = await simpleParser(item.source, { skipHtmlToText: true, skipTextToHtml: true });
        const htmlBody = typeof parsed.html === "string" ? parsed.html : "";
        yield {
          accountId: "primary",
          folder: settings.folder,
          uidValidity,
          uid: item.uid,
          messageId: parsed.messageId,
          subject: parsed.subject ?? "(无主题)",
          fromAddress: firstAddress(parsed.from),
          toAddress: firstAddress(parsed.to),
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          textBody: extractReadableEmailText({ textBody: parsed.text, htmlBody }),
          htmlBody,
          rawHeaders: parsed.headerLines.map((header) => header.line).join("\r\n"),
          rawSource: Buffer.from(item.source),
        };
      }
    } finally {
      lock?.release();
      if (connected) await client.logout();
    }
  }

  async function testConnection() {
    return withReadOnlyMailbox(async () => true);
  }

  return { fetchMessages, testConnection };
}

export type ImapMailSource = ReturnType<typeof createImapMailSource>;
