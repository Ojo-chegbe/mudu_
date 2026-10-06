import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream';
import react from '@vitejs/plugin-react';

function hostInstaller(): Plugin {
  return {
    name: 'mudu-host-installer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/downloads/mudu-host.exe') return next();
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD' });
          response.end();
          return;
        }
        const name = 'MUDU-Host-Setup-0.1.3-x64.exe';
        const path = resolve(process.cwd(), 'release/installers', name);
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Host installer is not built yet. Run npm run package:host.');
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="' + name + '"',
          'Content-Length': size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        if (request.method === 'HEAD') response.end();
        else pipeline(createReadStream(path), response, () => {});
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), hostInstaller()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  build: { outDir: 'dist', sourcemap: false },
});
