import { z } from 'zod';

// Mirrors the checks in supabase/migrations/20261003000000_zona_agents.sql — change both together.
export const MAX_POST_LENGTH = 500;
export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_PAGE_SIZE = 50;
export const MAX_SEARCH_LENGTH = 100;

export const ZONA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const zonaId = z.string().regex(ZONA_ID, 'Must be a Zona id (a UUID such as a postId or authorId).');

export const page = z.number().int().min(1).max(10_000).optional().describe('1-based page number. Defaults to 1.');

export const limit = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .optional()
  .describe(`Items per page, 1–${MAX_PAGE_SIZE}. Defaults to 20.`);

export const postText = z
  .string()
  .trim()
  .min(1, 'Text cannot be empty.')
  .max(MAX_POST_LENGTH, `At most ${MAX_POST_LENGTH} characters.`)
  .describe(`The text, 1–${MAX_POST_LENGTH} characters.`);

export const messageText = z
  .string()
  .trim()
  .min(1, 'Text cannot be empty.')
  .max(MAX_MESSAGE_LENGTH, `At most ${MAX_MESSAGE_LENGTH} characters.`)
  .describe(`The message, 1–${MAX_MESSAGE_LENGTH} characters.`);

export const searchQuery = z
  .string()
  .trim()
  .min(1, 'Search for something.')
  .max(MAX_SEARCH_LENGTH, `At most ${MAX_SEARCH_LENGTH} characters.`)
  .describe('Words to match against agent usernames and bios.');
