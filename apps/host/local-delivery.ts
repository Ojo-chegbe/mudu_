import { createServer, type RequestListener, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../../packages/exam-core/model.ts';
import type { LocalDeliveryStatus } from '../../packages/contracts/local-delivery.ts';

type Address = { name: string; address: string };
type Configuration = { address: string; acknowledged: true; enabled: boolean };
export function isPrivateIPv4(address: string) {
  const parts = address.split('.');
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^\d{1,3}$/.test(p) || String(Number(p)) !== p || Number(p) > 255)
  )
    return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function localAddresses(): Address[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => !entry.internal && entry.family === 'IPv4' && isPrivateIPv4(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  );
}
export function validateLocalConfiguration(value: unknown, addresses: Address[]): Configuration {
  if (!value || typeof value !== 'object')
    throw new DomainError('Choose your examination network.');
  const input = value as Record<string, unknown>;
  if (input.acknowledged !== true)
    throw new DomainError('Confirm that you understand local HTTP connections are not encrypted.');
  if (
    typeof input.address !== 'string' ||
    !isPrivateIPv4(input.address) ||
    !addresses.some((entry) => entry.address === input.address)
  )
    throw new DomainError(
      'This network address is no longer available. Connect to your router and refresh.',
    );
  return { address: input.address, acknowledged: true, enabled: input.enabled !== false };
}

export class LocalDelivery {
  private config: Configuration | null = null;
  private server: Server | null = null;
  private error: string | null = null;
  private busy = false;
  private devices = new Map<string, number>();
  private path: string;
  private handler: (origin: string) => Promise<RequestListener>;
  private addresses: () => Address[];
  private port: number;
  constructor(
    directory: string,
    handler: (origin: string) => Promise<RequestListener>,
    addresses = localAddresses,
    port = 4311,
  ) {
    this.path = join(directory, 'local-delivery.json');
    this.handler = handler;
    this.addresses = addresses;
    this.port = port;
  }
  status(): LocalDeliveryStatus {
    const now = Date.now();
    for (const [id, at] of this.devices) if (now - at > 120000) this.devices.delete(id);
    const addresses = this.addresses();
    const running = Boolean(this.server?.listening);
    const available = addresses.some((entry) => entry.address === this.config?.address);
    return {
      configured: Boolean(this.config),
      running,
      origin:
        running && available
          ? `http://${this.config!.address}:${(this.server!.address() as { port: number }).port}`
          : null,
      addresses,
      error:
        running && !available
          ? 'The examination network changed. Reconnect to the original router. Do not change networks during an examination.'
          : this.error,
      lastConnectionAt: this.devices.size ? Math.max(...this.devices.values()) : null,
      checkedDevices: running && available ? this.devices.size : 0,
    };
  }
  connection(address: string) {
    address = address.replace(/^::ffff:/, '');
    if (
      !this.server?.listening ||
      address === this.config?.address ||
      !isPrivateIPv4(address.replace(/^::ffff:/, ''))
    )
      return;
    if (this.devices.size < 1000 || this.devices.has(address))
      this.devices.set(address, Date.now());
  }
  private persist(config: Configuration) {
    const temporary = this.path + '.tmp';
    writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
  async restore() {
    if (!existsSync(this.path)) return;
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      if (value.enabled === false) return;
      this.config = validateLocalConfiguration(value, this.addresses());
      await this.start(this.config);
    } catch {
      this.error =
        'Local delivery could not restart. Connect to the examination router and start local delivery again.';
    }
  }
  async configure(value: unknown) {
    if (this.busy)
      throw new DomainError('Local delivery is already being prepared. Please wait.', 409);
    if (this.server?.listening)
      throw new DomainError('Stop local delivery before choosing another network.', 409);
    const config = validateLocalConfiguration(value, this.addresses());
    config.enabled = true;
    this.busy = true;
    try {
      await this.start(config);
      try {
        this.persist(config);
      } catch {
        await this.close();
        throw new DomainError(
          'Could not save local setup. Check the Host data folder permissions.',
        );
      }
      this.error = null;
    } finally {
      this.busy = false;
    }
  }
  private async start(config: Configuration) {
    const handler = await this.handler(`http://${config.address}:${this.port}`);
    const server = createServer((request, response) => {
      const address = request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
      // This is a local listener, not a public server. This check does not replace a firewall.
      if (!isPrivateIPv4(address)) {
        response.writeHead(403);
        response.end('Local network access only.');
        return;
      }
      handler(request, response);
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 50;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, config.address, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch {
      throw new DomainError(
        'Could not start local delivery. Reconnect to your router and check that port 4311 is not in use.',
      );
    }
    server.on('error', () => {
      this.error = 'The local server reported a connection error. Check the Host.';
    });
    this.config = config;
    this.server = server;
  }
  async stop() {
    if (this.busy) throw new DomainError('Please wait for local delivery to finish starting.', 409);
    if (this.config) this.persist({ ...this.config, enabled: false });
    await this.close();
    this.error = null;
  }
  async close() {
    const server = this.server;
    this.server = null;
    this.devices.clear();
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }
}
