import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const tools = [
  { name: 'check_school_inbox', description: 'Fetch recent unread or latest school emails.', inputSchema: { type: 'object', properties: { unreadOnly: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'search_school_email', description: 'Search school email by subject, sender, or text.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, from: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'read_school_email', description: 'Read a school email by IMAP UID.', inputSchema: { type: 'object', properties: { uid: { type: 'number' } }, required: ['uid'] } }
];

function client() {
  const user = process.env.SCHOOL_EMAIL;
  const pass = process.env.SCHOOL_APP_PASSWORD;
  if (!user || !pass) throw new Error('SCHOOL_EMAIL and SCHOOL_APP_PASSWORD must be configured');
  const host = process.env.SCHOOL_IMAP_HOST || user.split('@')[1];
  if (!host) throw new Error('Unable to infer IMAP host; set SCHOOL_IMAP_HOST');
  return new ImapFlow({ host, port: Number(process.env.SCHOOL_IMAP_PORT || 993), secure: true, auth: { user, pass } });
}

async function withMailbox<T>(fn: (c: ImapFlow) => Promise<T>) {
  const c = client(); await c.connect();
  try { await c.mailboxOpen(process.env.SCHOOL_IMAP_MAILBOX || 'INBOX'); return await fn(c); }
  finally { await c.logout().catch(() => undefined); }
}

async function listMessages(args: any) {
  const limit = Math.min(Math.max(Number(args?.limit || 10), 1), 50);
  return withMailbox(async c => {
    const range = args?.unreadOnly ? 'UNSEEN' : '*';
    const rows: any[] = [];
    for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
      rows.push({ uid: m.uid, subject: m.envelope?.subject, from: m.envelope?.from?.map((x: any) => x.address || x.name), date: m.internalDate, unread: !m.flags?.has('\\Seen') });
    }
    return rows.slice(-limit).reverse();
  });
}

async function search(args: any) {
  const query = String(args.query || '');
  const from = args.from ? String(args.from) : undefined;
  return withMailbox(async c => {
    const uids = await c.search({ ...(from ? { from } : {}), or: [{ subject: query }, { body: query }, { from: query }] });
    const selected = uids.slice(-Math.min(Number(args.limit || 25), 50)).reverse();
    const out: any[] = [];
    for await (const m of c.fetch(selected, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) out.push({ uid: m.uid, subject: m.envelope?.subject, from: m.envelope?.from?.map((x: any) => x.address || x.name), date: m.internalDate, unread: !m.flags?.has('\\Seen') });
    return out;
  });
}

async function read(args: any) {
  const uid = Number(args.uid);
  if (!Number.isInteger(uid) || uid < 1) throw new Error('uid must be a positive integer');
  return withMailbox(async c => {
    const msg = await c.fetchOne(uid, { source: true, uid: true }, { uid: true });
    if (!msg?.source) throw new Error('Email not found');
    const parsed = await simpleParser(msg.source);
    return { uid, subject: parsed.subject, from: parsed.from?.text, to: parsed.to?.text, date: parsed.date, text: parsed.text, html: parsed.html ? String(parsed.html) : undefined, attachments: parsed.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })) };
  });
}

async function call(name: string, args: any) {
  if (name === 'check_school_inbox') return listMessages(args);
  if (name === 'search_school_email') return search(args);
  if (name === 'read_school_email') return read(args);
  throw new Error(`Unknown tool: ${name}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const id = body?.id ?? null;
  try {
    let result: any;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'school-mail-mcp', version: '1.0.0' } };
    else if (body.method === 'notifications/initialized') return res.status(204).end();
    else if (body.method === 'tools/list') result = { tools };
    else if (body.method === 'tools/call') { const data = await call(body.params?.name, body.params?.arguments || {}); result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }; }
    else throw new Error(`Method not found: ${body.method}`);
    return res.status(200).json({ jsonrpc: '2.0', id, result });
  } catch (e: any) { return res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32000, message: e?.message || 'Request failed' } }); }
}
