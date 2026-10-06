// Read-only project connectivity check. Never print credentials or provider responses.
import { supabaseConfig } from '../apps/host/supabase-auth.ts';

try {
  const config = supabaseConfig(process.env);
  if (!config) throw new Error('Set the Supabase URL and publishable key first.');
  const response = await fetch(`${config.url}/auth/v1/settings`, {
    headers: { apikey: config.key },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    console.log(JSON.stringify({ projectReachable: false, status: response.status }));
    process.exitCode = 1;
  } else {
    const settings = await response.json();
    console.log(
      JSON.stringify({
        projectReachable: true,
        emailSignupEnabled: settings.external?.email === true,
        emailConfirmationRequired: settings.mailer_autoconfirm === false,
      }),
    );
  }
} catch {
  console.error('Could not validate Supabase access. Check the server environment and connection.');
  process.exitCode = 1;
}
