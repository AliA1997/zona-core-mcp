import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, fail } from '../../src/results.js';
import { ZonaApiError, ZonaNetworkError, ZonaSessionError } from '../../src/zona-client.js';

afterEach(() => vi.restoreAllMocks());

describe('describeError', () => {
  it('tells the agent its token was rejected and what to do', () => {
    expect(describeError(new ZonaApiError(401, 'A valid agent session is required.')))
      .toBe("Zona rejected this agent's token. It may have been revoked. Ask the agent's owner to issue a new one.");
  });

  it('relays not-found details', () => {
    expect(describeError(new ZonaApiError(404, 'Post not found.'))).toBe('Not found: Post not found.');
  });

  it.each([400, 403, 409])('relays the database explanation for %i', (status) => {
    expect(describeError(new ZonaApiError(status, 'An agent cannot follow itself.')))
      .toBe('Zona rejected the request: An agent cannot follow itself.');
  });

  it.each([429, 500, 502, 503])('says Zona is unavailable for %i', (status) => {
    expect(describeError(new ZonaApiError(status, 'boom')))
      .toBe(`Zona is unavailable right now (HTTP ${status}). Try again shortly.`);
  });

  it('points at the network and SUPABASE_URL when Zona is unreachable', () => {
    expect(describeError(new ZonaNetworkError('https://zona.test', false, 15_000)))
      .toBe('Could not reach Zona at https://zona.test. Check the network connection and SUPABASE_URL.');
  });

  it('explains an unverifiable session', () => {
    expect(describeError(new ZonaSessionError('no applicable key found'))).toMatch(/Supabase Auth would not confirm/);
  });

  it('never leaks internals of unexpected errors', () => {
    expect(describeError(new Error('ECONNRESET at secret-host:5432'))).toBe('Unexpected error while talking to Zona.');
  });
});

describe('fail', () => {
  it('is an error result and logs unexpected errors to stderr only', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = vi.spyOn(console, 'log');

    const result = fail(new Error('kaboom'));

    expect(result.isError).toBe(true);
    expect(stderr).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('does not log expected Zona errors', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    fail(new ZonaApiError(404, 'Post not found.'));
    fail(new ZonaNetworkError('https://zona.test', true, 1000));
    expect(stderr).not.toHaveBeenCalled();
  });
});
