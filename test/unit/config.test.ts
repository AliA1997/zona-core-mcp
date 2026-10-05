import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_PUBLISHABLE_KEY,
  DEFAULT_SCHEMA,
  DEFAULT_SUPABASE_URL,
  loadConfig,
} from '../../src/config.js';

const AGENT_ID = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const SECRET = 'a'.repeat(43);
const TOKEN = `zat_0b1c2d3e4f5046178293a4b5c6d7e8f9_${SECRET}`;
const legacyKey = (role: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.c2lnbmF0dXJl`;

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('needs only the token: everything else defaults to the Zona project', () => {
    expect(loadConfig({ ZONA_AGENT_TOKEN: TOKEN })).toEqual({
      agentId: AGENT_ID,
      agentSecret: SECRET,
      supabaseUrl: DEFAULT_SUPABASE_URL,
      publishableKey: DEFAULT_PUBLISHABLE_KEY,
      schema: DEFAULT_SCHEMA,
    });
  });

  it('tolerates whitespace pasted around the token', () => {
    expect(loadConfig({ ZONA_AGENT_TOKEN: `  ${TOKEN}\n` }).agentSecret).toBe(SECRET);
  });

  it('strips trailing slashes from an overridden SUPABASE_URL', () => {
    const config = loadConfig({ ZONA_AGENT_TOKEN: TOKEN, SUPABASE_URL: 'https://other.supabase.co//' });
    expect(config.supabaseUrl).toBe('https://other.supabase.co');
  });

  it('takes an explicit publishable key and schema', () => {
    const config = loadConfig({
      ZONA_AGENT_TOKEN: TOKEN,
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_other',
      SUPABASE_SCHEMA: 'staging',
    });
    expect(config).toMatchObject({
      publishableKey: 'sb_publishable_other',
      schema: 'staging',
    });
  });

  it('rejects a missing token with instructions', () => {
    expect(messageOf(() => loadConfig({}))).toMatch(/ZONA_AGENT_TOKEN is not set/);
    expect(messageOf(() => loadConfig({ ZONA_AGENT_TOKEN: '   ' }))).toMatch(/ZONA_AGENT_TOKEN is not set/);
  });

  it.each([
    'eyJhbGciOiJIUzI1NiJ9.eyJuYW1laWQiOiJ4In0.c2lnbmF0dXJl',
    `zat_${'a'.repeat(43)}`,
  ])('rejects a value that is not an agent token without echoing it: %s', (value) => {
    const message = messageOf(() => loadConfig({ ZONA_AGENT_TOKEN: value }));
    expect(message).toMatch(/not a Zona agent token/);
    expect(message).not.toContain(value);
  });

  it.each([
    ['an sb_secret_ key', 'sb_secret_abcdefghijklmnopqrstuvwxyz012345'],
    ['a legacy service_role key', legacyKey('service_role')],
  ])('refuses %s in the publishable slot without echoing it', (_label, key) => {
    const message = messageOf(() => loadConfig({ ZONA_AGENT_TOKEN: TOKEN, SUPABASE_PUBLISHABLE_KEY: key }));
    expect(message).toMatch(/Never give an agent server a secret key/);
    expect(message).not.toContain(key);
  });

  it('accepts a legacy anon key', () => {
    const key = legacyKey('anon');
    expect(loadConfig({ ZONA_AGENT_TOKEN: TOKEN, SUPABASE_PUBLISHABLE_KEY: key }).publishableKey).toBe(key);
  });

  it('rejects something that is not a publishable key', () => {
    expect(messageOf(() => loadConfig({ ZONA_AGENT_TOKEN: TOKEN, SUPABASE_PUBLISHABLE_KEY: 'hunter2' })))
      .toMatch(/not a Supabase publishable key/);
  });

  it.each(['SUPABASE_URL'])('never echoes a secret pasted into %s', (name) => {
    for (const secret of ['sb_secret_abcdefghijklmnop', TOKEN, 'https://user:hunter2@iwybbgueyuxruebekmpy.supabase.co']) {
      expect(messageOf(() => loadConfig({ ZONA_AGENT_TOKEN: TOKEN, [name]: secret }))).not.toMatch(/sb_secret_|zat_|hunter2/);
    }
  });

  it('never reads SUPABASE_SECRET_KEY', () => {
    const config = loadConfig({ ZONA_AGENT_TOKEN: TOKEN, SUPABASE_SECRET_KEY: 'sb_secret_should_be_ignored' });
    expect(JSON.stringify(config)).not.toContain('sb_secret_should_be_ignored');
  });

  it.each([
    ['SUPABASE_URL', 'http://iwybbgueyuxruebekmpy.supabase.co'],
    ['SUPABASE_URL', 'http://10.0.0.5:54321'],
  ])('refuses plain http for a real host in %s', (name, url) => {
    expect(messageOf(() => loadConfig({ ZONA_AGENT_TOKEN: TOKEN, [name]: url }))).toMatch(/https/);
  });

  it.each(['http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321'])(
    'allows plain http for a local Supabase at %s',
    (url) => {
      expect(loadConfig({ ZONA_AGENT_TOKEN: TOKEN, SUPABASE_URL: url }).supabaseUrl).toBe(url);
    },
  );

  it.each(['not a url', 'ftp://iwybbgueyuxruebekmpy.supabase.co'])('rejects the unusable URL %j', (url) => {
    messageOf(() => loadConfig({ ZONA_AGENT_TOKEN: TOKEN, SUPABASE_URL: url }));
  });
});
