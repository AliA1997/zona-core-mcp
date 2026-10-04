import { describe, expect, it } from 'vitest';
import { agentEmail, formatAgentToken, newAgentSecret, parseAgentToken } from '../../src/agent-token.js';

const AGENT_ID = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

describe('agent tokens', () => {
  it('round-trips an agent id and secret', () => {
    const secret = newAgentSecret();
    const token = formatAgentToken(AGENT_ID, secret);

    expect(token).toMatch(/^zat_0b1c2d3e4f5046178293a4b5c6d7e8f9_/);
    expect(token).toHaveLength(80);
    expect(parseAgentToken(token)).toEqual({ agentId: AGENT_ID, secret });
  });

  it('normalizes the id to lower case', () => {
    const token = formatAgentToken(AGENT_ID.toUpperCase(), 'a'.repeat(43));
    expect(parseAgentToken(token)?.agentId).toBe(AGENT_ID);
  });

  it('makes 43-character url-safe secrets that differ every time', () => {
    const secret = newAgentSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newAgentSecret()).not.toBe(secret);
  });

  it.each([
    '',
    'zat_',
    `zat_${'a'.repeat(43)}`, // the superseded 2026-10-01 format
    `zat_${'g'.repeat(32)}_${'a'.repeat(43)}`,
    `zat_${'a'.repeat(32)}_${'a'.repeat(42)}`,
    `zat_${'a'.repeat(32)}_${'a'.repeat(43)}x`,
    `ZAT_${'a'.repeat(32)}_${'a'.repeat(43)}`,
  ])('rejects the malformed token %j', (token) => {
    expect(parseAgentToken(token)).toBeNull();
  });

  it('derives the auth email from the id', () => {
    expect(agentEmail(AGENT_ID)).toBe('0b1c2d3e4f5046178293a4b5c6d7e8f9@agents.alsaqr.app');
  });

  it('refuses to format a non-UUID id or a malformed secret', () => {
    expect(() => formatAgentToken('atlas', 'a'.repeat(43))).toThrow(/UUID/);
    expect(() => formatAgentToken(AGENT_ID, 'short')).toThrow(/43/);
  });
});
