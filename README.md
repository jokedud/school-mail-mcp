# School Mail MCP

A Vercel serverless MCP endpoint that reads a school mailbox over IMAP. Credentials are never stored in the repository.

## Deploy to Vercel

Import this repository at https://vercel.com/new. In Vercel project settings, add:

- `SCHOOL_EMAIL`: the school mailbox address
- `SCHOOL_APP_PASSWORD`: an app-specific password (not your normal password)
- `SCHOOL_IMAP_HOST`: optional IMAP hostname; otherwise inferred from the email domain
- `SCHOOL_IMAP_PORT`: optional, defaults to `993`
- `SCHOOL_IMAP_MAILBOX`: optional, defaults to `INBOX`

The MCP HTTP endpoint is `/api/mcp`. It accepts JSON-RPC POST requests and supports `initialize`, `tools/list`, and `tools/call` for `check_school_inbox`, `search_school_email`, and `read_school_email`. Restrict CORS and add authentication before exposing it publicly in production.

## Example

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```
