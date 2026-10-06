import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Only public cloud configuration belongs in a distributable installer.
export function publicConfiguration(env) {
  const url = env.MUDU_SUPABASE_URL;
  const key = env.MUDU_SUPABASE_PUBLISHABLE_KEY;
  if (!url && !key) return {};
  if (!url || !key || new URL(url).protocol !== 'https:')
    throw new Error('Provide both a public HTTPS Supabase URL and publishable key.');
  let publishable = key.startsWith('sb_publishable_');
  if (!publishable) {
    try {
      publishable = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon';
    } catch {
      /* Not a legacy anonymous key. */
    }
  }
  if (!publishable) throw new Error('Only a publishable or legacy anon key may be packaged.');
  return { MUDU_SUPABASE_URL: url, MUDU_SUPABASE_PUBLISHABLE_KEY: key };
}

export function hostEnvironment(inherited, configuration, directory, port = 4310) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => !key.startsWith('MUDU_')),
  );
  return {
    ...env,
    ...publicConfiguration(configuration),
    MUDU_DATA_DIR: resolve(directory),
    MUDU_BIND: '127.0.0.1',
    MUDU_PORT: String(port),
    MUDU_ORIGIN: `http://127.0.0.1:${port}`,
    MUDU_DESKTOP: '1',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = process.argv[2];
  if (!directory) throw new Error('The launcher must provide the Host data directory.');
  const configPath = join(root, 'host-public.json');
  const configuration = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const env = hostEnvironment(
    process.env,
    configuration,
    directory,
    Number(process.argv[3] ?? 4310),
  );
  for (const key of Object.keys(process.env)) if (key.startsWith('MUDU_')) delete process.env[key];
  Object.assign(process.env, env);
  // Optional operator-managed secrets stay outside the installation directory.
  // Database credentials are deliberately not accepted by this local-only launcher.
  const privatePath = join(directory, 'host.env');
  if (existsSync(privatePath)) {
    const privateEnv = parseEnv(readFileSync(privatePath, 'utf8'));
    if (privateEnv.MUDU_GOOGLE_AI_KEY)
      process.env.MUDU_GOOGLE_AI_KEY = privateEnv.MUDU_GOOGLE_AI_KEY;
  }
  await import('../host/main.ts');
}
