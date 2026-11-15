import { spawn, type ChildProcess } from 'node:child_process';
import type { LeveeClient } from '../src/levee/client';
import type { LeveeTenant } from '../src/levee/types';
import { parseQuickTunnelUrl } from '../src/webhooks/endpoint';

/** How long cloudflared gets to print its quick tunnel URL. */
const TUNNEL_START_TIMEOUT_MS = 45_000;

export const CLOUDFLARED_INSTALL_HINT = [
  'cloudflared is not installed. Install it to open Acme on a public https URL:',
  '  macOS     brew install cloudflared',
  '  Windows   winget install --id Cloudflare.cloudflared',
  '  Linux     https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  'No Cloudflare account is needed; quick tunnels are anonymous.',
].join('\n');

/** Whether the cloudflared binary can be run. */
export function cloudflaredInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('cloudflared', ['--version'], { stdio: 'ignore' });
    child.once('error', () => {
      resolve(false);
    });
    child.once('exit', (code) => {
      resolve(code === 0);
    });
  });
}

/** Starts cloudflared and resolves with the quick tunnel origin it prints. */
export function startQuickTunnel(localUrl: string): Promise<{ child: ChildProcess; origin: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', localUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const finish = (error: Error | null, origin = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) {
        resolve({ child, origin });
        return;
      }
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error('cloudflared did not report a tunnel URL in time. Check your network and try again.'));
    }, TUNNEL_START_TIMEOUT_MS);
    const onOutput = (chunk: Buffer) => {
      if (settled) return;
      output = (output + chunk.toString('utf8')).slice(-16_384);
      const origin = parseQuickTunnelUrl(output);
      if (origin !== null) finish(null, origin);
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(
        new Error(
          error.code === 'ENOENT' ? CLOUDFLARED_INSTALL_HINT : `cloudflared failed to start (${error.code ?? 'error'})`,
        ),
      );
    });
    child.once('exit', (code) => {
      finish(new Error(`cloudflared exited with code ${code ?? 'unknown'} before the tunnel was up`));
    });
  });
}

/**
 * Points the tenant's passkey relying party at `origin` with the same PATCH setup uses. Levee
 * requires every web origin to sit under the RP ID, so for the run the tunnel host is the RP ID and
 * its origin the only web origin; Android app origins are kept. Returns whether anything changed.
 */
export async function pointPasskeysAt(
  levee: Pick<LeveeClient, 'get' | 'patch'>,
  platformId: string,
  tenantId: string,
  origin: string,
): Promise<boolean> {
  const base = `/v1/platforms/${encodeURIComponent(platformId)}/tenants`;
  const tenants = await levee.get<unknown>(base);
  const tenant = (Array.isArray(tenants) ? (tenants as LeveeTenant[]) : []).find((entry) => entry.id === tenantId);
  if (tenant === undefined) {
    throw new Error('This platform key no longer owns the configured tenant. Run `npm run setup`.');
  }
  const rpId = new URL(origin).hostname;
  const apps = (tenant.webauthn?.origins ?? []).filter((entry) => entry.startsWith('android:'));
  const origins = [origin, ...apps];
  const current = tenant.webauthn?.origins ?? [];
  if (
    tenant.webauthn?.rpId === rpId &&
    current.length === origins.length &&
    origins.every((o) => current.includes(o))
  ) {
    return false;
  }
  await levee.patch(`${base}/${encodeURIComponent(tenantId)}/webauthn`, { rp_id: rpId, origins });
  return true;
}
