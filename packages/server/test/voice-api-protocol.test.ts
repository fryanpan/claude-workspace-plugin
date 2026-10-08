/**
 * The voice API's wire format: what a chat request becomes, and what is
 * refused before any agent hears it.
 */
import { describe, expect, it } from 'bun:test';
import {
  type ApiError,
  type ChatTurn,
  HISTORY_KEEP,
  TURN_MAX,
  bearerOf,
  conversationIdFor,
  parseChatRequest,
} from '../src/voice-api/protocol.ts';

const ok = (body: unknown, header: string | null = null) =>
  parseChatRequest(body, header) as ChatTurn;
const err = (body: unknown) => (parseChatRequest(body, null) as ApiError).body.error.code;

describe('parseChatRequest', () => {
  it('takes the last user message as the turn and the rest as history', () => {
    const t = ok({
      model: 'riverbend-helper',
      stream: true,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'how far is Saltmarsh' },
        { role: 'assistant', content: 'Working on it. Twelve miles.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'and ' },
            { type: 'text', text: 'back' },
          ],
        },
      ],
    });
    expect(t.text).toBe('and back');
    expect(t.stream).toBe(true);
    expect(t.history).toEqual([
      { from: 'owner', text: 'how far is Saltmarsh' },
      { from: 'agent', text: 'Twelve miles.' },
    ]);
  });

  it('derives one conversation id from the model and first message, or takes the header', () => {
    const one = ok({ model: 'a', messages: [{ role: 'user', content: 'hi' }] });
    const two = ok({
      model: 'a',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'more' },
      ],
    });
    expect(two.conversationId).toBe(one.conversationId);
    expect(ok({ model: 'b', messages: [{ role: 'user', content: 'hi' }] }).conversationId).not.toBe(
      one.conversationId,
    );
    expect(
      ok({ model: 'a', messages: [{ role: 'user', content: 'hi' }] }, 'phone-7').conversationId,
    ).toBe('phone-7');
    expect(conversationIdFor('a', 'hi', 'not ok!')).toBe(one.conversationId);
  });

  it('keeps only the newest history turns', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn ${i}`,
    }));
    messages.push({ role: 'user', content: 'now' });
    expect(ok({ model: 'a', messages }).history).toHaveLength(HISTORY_KEEP);
  });

  it('refuses a body no agent should hear', () => {
    expect(err(null)).toBe('invalid_body');
    expect(err({ messages: [{ role: 'user', content: 'hi' }] })).toBe('invalid_model');
    expect(err({ model: '../x', messages: [{ role: 'user', content: 'hi' }] })).toBe(
      'invalid_model',
    );
    expect(err({ model: 'a', messages: [] })).toBe('invalid_messages');
    expect(err({ model: 'a', messages: [{ role: 'assistant', content: 'hi' }] })).toBe(
      'invalid_messages',
    );
    expect(err({ model: 'a', messages: [{ role: 'user', content: '   ' }] })).toBe(
      'invalid_messages',
    );
    expect(
      err({ model: 'a', messages: [{ role: 'user', content: 'x'.repeat(TURN_MAX + 1) }] }),
    ).toBe('turn_too_long');
  });
});

describe('bearerOf', () => {
  it('reads a Bearer in any case, and nothing else', () => {
    expect(bearerOf(new Headers({ authorization: 'bearer vk1.a.b' }))).toBe('vk1.a.b');
    expect(bearerOf(new Headers({ authorization: 'Basic abc' }))).toBeNull();
    expect(bearerOf(new Headers())).toBeNull();
  });
});
