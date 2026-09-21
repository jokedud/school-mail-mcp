import http, { IncomingMessage, ServerResponse } from 'node:http';
import mcpHandler from './api/mcp.js';

const port = Number(process.env.PORT || 3000);

function responseAdapter(res: ServerResponse): any {
  return {
    setHeader: (name: string, value: string) => { res.setHeader(name, value); },
    status: (code: number) => { res.statusCode = code; return responseAdapter(res); },
    json: (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); },
    end: (body?: string) => res.end(body)
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); return; }
  if (req.url === '/api/mcp' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: 'school-mail-mcp', endpoint: '/api/mcp', methods: ['POST'] })); return; }
  if (req.url !== '/api/mcp' || req.method !== 'POST') { res.statusCode = 404; res.end('Not found'); return; }
  try {
    const body = await readBody(req);
    await mcpHandler({ ...req, body, method: 'POST' } as never, responseAdapter(res));
  } catch (error: unknown) {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid request' }));
  }
});

server.listen(port, '0.0.0.0', () => console.log(`School Mail MCP listening on port ${port}`));
