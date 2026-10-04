const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

export interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function requiredVars(server: unknown): string[] {
  const vars = new Set<string>();
  for (const match of JSON.stringify(server ?? {}).matchAll(VAR_RE)) {
    if (!match[2]) vars.add(match[1]);
  }
  return [...vars];
}

export function filterMcpConfig(config: McpConfigFile, missingEnv: Set<string>): { config: McpConfigFile; dropped: string[] } {
  const servers = config.mcpServers ?? {};
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (requiredVars(server).some((v) => missingEnv.has(v))) dropped.push(name);
    else kept[name] = server;
  }
  return { config: { ...config, mcpServers: kept }, dropped };
}
