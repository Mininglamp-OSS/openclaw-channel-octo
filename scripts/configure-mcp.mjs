import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** Build-time deployment configuration, shipped with the plugin; no user input required. */
export function configureMcpBuild(root, value) {
  const manifestPath = resolve(root, 'openclaw.plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const legacy = manifest.mcpServers?.['octo-business'];
  if (legacy !== undefined) {
    if (Object.hasOwn(manifest.mcpServers, 'octo-mcp')) throw new Error('Conflicting Octo MCP manifest service names.');
    manifest.mcpServers['octo-mcp'] = legacy;
    delete manifest.mcpServers['octo-business'];
  }
  if (value === undefined) {
    if (legacy !== undefined) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return;
  }
  let endpoint;
  if (value.trim()) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('Invalid deployment OCTO_MCP_URL.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash) {
      throw new Error('Deployment OCTO_MCP_URL must use HTTPS or loopback HTTP without credentials, query or fragment.');
    }
    endpoint = url.href;
  }
  if (endpoint) {
    manifest.mcpServers ??= {};
    manifest.mcpServers['octo-mcp'] = { transport: 'streamable-http', url: endpoint };
  } else if (manifest.mcpServers) {
    delete manifest.mcpServers['octo-mcp'];
    if (!Object.keys(manifest.mcpServers).length) delete manifest.mcpServers;
  }
  writeFileSync(resolve(root, 'src/mcp-deployment.ts'),
    '// Deployment default. The build injects OCTO_MCP_URL when it is provided.\n'
    + `export const BUNDLED_MCP_URL: string | undefined = ${endpoint ? JSON.stringify(endpoint) : 'undefined'};\n`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  configureMcpBuild(fileURLToPath(new URL('../', import.meta.url)), process.env.OCTO_MCP_URL);
}
