import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type TestEnv = {
  supabaseUrl: string;
  publishableKey: string;
  secretKey: string;
  schema: string;
};

const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/** Reads the gitignored .env (see .env.example). Never print what this returns. */
export function loadTestEnv(): TestEnv {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const read = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new Error(`${name} is not set. Fill it in .env (see .env.example): integration tests run against the real Supabase project.`);
    }
    return value;
  };

  const supabaseUrl = read('SUPABASE_URL').replace(/\/+$/, '');
  const secretKey = read('SUPABASE_SECRET_KEY');
  if (!secretKey.startsWith('sb_secret_')) {
    throw new Error(
      'SUPABASE_SECRET_KEY in .env must be the project secret key (sb_secret_…, Dashboard → Project Settings → API Keys), not the publishable key.',
    );
  }
  return {
    supabaseUrl,
    publishableKey: read('SUPABASE_PUBLISHABLE_KEY'),
    secretKey,
    schema: process.env.SUPABASE_SCHEMA?.trim() || 'alsaqr-2026',
  };
}
