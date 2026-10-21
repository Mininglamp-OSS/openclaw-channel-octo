import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureMcpBuild } from '../scripts/configure-mcp.mjs';

describe('deployment-provided MCP endpoint', () => {
  it('leaves source and manifest byte-identical when no deployment variable is provided', () => {
    const root = mkdtempSync(join(tmpdir(), 'octo-mcp-unconfigured-'));
    try {
      mkdirSync(join(root, 'src'));
      const manifest = '{"id":"octo"}\n'; const source = 'export const BUNDLED_MCP_URL = undefined;\n';
      writeFileSync(join(root, 'openclaw.plugin.json'), manifest);
      writeFileSync(join(root, 'src/mcp-deployment.ts'), source);
      configureMcpBuild(root, undefined);
      expect(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8')).toBe(manifest);
      expect(readFileSync(join(root, 'src/mcp-deployment.ts'), 'utf8')).toBe(source);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('retires the old manifest service name while preserving an existing release endpoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'octo-mcp-name-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'openclaw.plugin.json'), JSON.stringify({ id: 'octo', mcpServers: {
        'octo-business': { transport: 'streamable-http', url: 'https://existing.test/' },
      } }));
      configureMcpBuild(root, undefined);
      const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
      expect(manifest.mcpServers['octo-business']).toBeUndefined();
      expect(manifest.mcpServers['octo-mcp'].url).toBe('https://existing.test/');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('ships an explicit Streamable HTTP declaration and resolver default from one deployment variable', () => {
    const root = mkdtempSync(join(tmpdir(), 'octo-mcp-build-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'openclaw.plugin.json'), JSON.stringify({ id: 'octo', mcpServers: { other: { command: 'other' } } }));
      configureMcpBuild(root, 'https://deployment.test/mcp');
      const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
      expect(manifest.mcpServers['octo-mcp']).toEqual({ transport: 'streamable-http', url: 'https://deployment.test/mcp' });
      expect(manifest.mcpServers.other).toEqual({ command: 'other' });
      const generated = readFileSync(join(root, 'src/mcp-deployment.ts'), 'utf8');
      expect(generated).toContain('https://deployment.test/mcp');
      configureMcpBuild(root, undefined);
      expect(readFileSync(join(root, 'src/mcp-deployment.ts'), 'utf8')).toBe(generated);
      expect(() => configureMcpBuild(root, 'https://user:secret@mcp.test/')).toThrow(/OCTO_MCP_URL/);
      expect(readFileSync(join(root, 'src/mcp-deployment.ts'), 'utf8')).toBe(generated);
      configureMcpBuild(root, '');
      expect(JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8')).mcpServers['octo-mcp']).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
