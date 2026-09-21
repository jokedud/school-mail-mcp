import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

type ToolArgs = Record<string, unknown>;
type MailSummary = { uid: number; subject?: string; from?: string[]; date?: string; unread: boolean };
type RequestBody = { id?: string | number | null; method: string; params?: { name?: string; arguments?: ToolArgs } };

const tools = [
  { name: 'check_school_inbox', description: 'Fetch recent unread or latest school emails.', inputSchema: { type: 'object', properties: { unreadOnly: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'search_school_email', description: 'Search school email by subject, sender, or text.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, from: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'read_school_email', description: 'Read a school email by IMAP UID.', inputSchema: { type: 'object', properties: { uid: { type: 'number' } }, required: ['uid'] } }
];

function client(): ImapFlow {
  const user = process.env.SCHOOL_EMAIL;
  const pass = process.env.SCHOOL_APP_PASSWORD;
  if (!user || !pass) throw new Error('SCHOOL_EMAIL and SCHOOL_APP_PASSWORD must be configured');
  const host = process.env.SCHOOL_IMAP_HOST || user.split('@')[1];
  if (!host) throw new Error('Unable to infer IMAP host; set SCHOOL_IMAP_HOST');
  return new ImapFlow({ host, port: Number(process.env.SCHOOL_IMAP_PORT || 993), secure: true, auth: { user, pass } });
}

async function withMailbox<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = client(); await c.connect();
  try { await c.mailboxOpen(process.env.SCHOOL_IMAP_MAILBOX || 'INBOX'); return await fn(c); }
  finally { await c.logout().catch(() => undefined); }
}

function argNumber(args: ToolArgs, key: string, fallback: number): number { return typeof args[key] === 'number' ? args[key] as number : fallback; }
function argString(args: ToolArgs, key: string): string | undefined { return typeof args[key] === 'string' ? args[key] as string : undefined; }
function addressText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(addressText).filter((x): x is string => Boolean(x)).join(', ') || undefined;
  if (typeof value === 'object' && value !== null && 'text' in value) return String((value as { text?: unknown }).text || '');
  return undefined;
}
function isoDate(value: string | Date | undefined): string | undefined { return value ? new Date(value).toISOString() : undefined; }

async function listMessages(args: ToolArgs): Promise<MailSummary[]> {
  const limit = Math.min(Math.max(argNumber(args, 'limit', 10), 1), 50);
  return withMailbox(async (c: ImapFlow) => {
    const range = args.unreadOnly === true ? 'UNSEEN' : '*';
    const rows: MailSummary[] = [];
    for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
      rows.push({ uid: m.uid, subject: m.envelope?.subject, from: m.envelope?.from?.map((x: { address?: string; name?: string }) => x.address || x.name || ''), date: isoDate(m.internalDate), unread: !m.flags?.has('\\Seen') });
    }
    return rows.slice(-limit).reverse();
  });
}

async function search(args: ToolArgs): Promise<MailSummary[]> {
  const query = argString(args, 'query') || '';
  const from = argString(args, 'from');
  return withMailbox(async (c: ImapFlow) => {
    const uids = await c.search({ ...(from ? { from } : {}), or: [{ subject: query }, { body: query }, { from: query }] });
    if (uids === false) return [];
    const selected = uids.slice(-Math.min(argNumber(args, 'limit', 25), 50)).reverse();
    const out: MailSummary[] = [];
    for await (const m of c.fetch(selected, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) out.push({ uid: m.uid, subject: m.envelope?.subject, from: m.envelope?.from?.map((x: { address?: string; name?: string }) => x.address || x.name || ''), date: isoDate(m.internalDate), unread: !m.flags?.has('\\Seen') });
    return out;
  });
}

async function read(args: ToolArgs): Promise<Record<string, unknown>> {
  const uid = Number(args.uid);
  if (!Number.isInteger(uid) || uid < 1) throw new Error('uid must be a positive integer');
  return withMailbox(async (c: ImapFlow) => {
    const msg = await c.fetchOne(uid, { source: true, uid: true }, { uid: true });
    if (msg === false || !msg.source) throw new Error('Email not found');
    const parsed = await simpleParser(msg.source);
    return { uid, subject: parsed.subject, from: addressText(parsed.from), to: addressText(parsed.to), date: isoDate(parsed.date), text: parsed.text, html: parsed.html ? String(parsed.html) : undefined, attachments: parsed.attachments.map((a: { filename?: string; contentType: string; size: number }) => ({ filename: a.filename, contentType: a.contentType, size: a.size })) };
  });
}

async function call(name: string, args: ToolArgs): Promise<unknown> {
  if (name === 'check_school_inbox') return listMessages(args);
  if (name === 'search_school_email') return search(args);
  if (name === 'read_school_email') return read(args);
  throw new Error(`Unknown tool: ${name}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST required' }); return; }
  const body: RequestBody = typeof req.body === 'string' ? JSON.parse(req.body) as RequestBody : req.body as RequestBody;
  const id = body.id ?? null;
  try {
    let result: unknown;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'school-mail-mcp', version: '1.0.0' } };
    else if (body.method === 'notifications/initialized') { res.status(204).end(); return; }
    else if (body.method === 'tools/list') result = { tools };
    else if (body.method === 'tools/call') { const data = await call(body.params?.name || '', body.params?.arguments || {}); result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
    else throw new Error(`Method not found: ${body.method}`);
    res.status(200).json({ jsonrpc: '2.0', id, result });
  } catch (e: unknown) { const message = e instanceof Error ? e.message : 'Request failed'; res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32000, message } }); }
}
