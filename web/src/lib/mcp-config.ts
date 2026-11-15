/** Ready-to-paste MCP client configuration for an agent token. */
export function mcpConfig(client: string, url: string, token: string): string {
  switch (client) {
    case 'claude_desktop':
      return JSON.stringify(
        {
          mcpServers: {
            'acme-pay': {
              command: 'npx',
              args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${ACME_AUTH}'],
              env: { ACME_AUTH: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      );
    case 'codex':
      return [
        '[mcp_servers.acme-pay]',
        `url = ${JSON.stringify(url)}`,
        `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`,
      ].join('\n');
    case 'claude_code':
      return `claude mcp add --transport http acme-pay \\\n  ${url} \\\n  --header "Authorization: Bearer ${token}"`;
    default:
      return JSON.stringify(
        { mcpServers: { 'acme-pay': { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      );
  }
}

export const CLIENTS = [
  { value: 'claude_desktop', label: 'Claude Desktop' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'other', label: 'Another MCP client' },
] as const;

export function clientLabel(client: string): string {
  return CLIENTS.find((entry) => entry.value === client)?.label ?? 'MCP client';
}
