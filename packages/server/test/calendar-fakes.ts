/**
 * Fakes for the calendar bot: the Google flow, the Recall calendar client,
 * the bot relay's client and the token vault, each recording what it was
 * asked. The real ones spend money. Every credential is a literal invented
 * here, and the hosts are fictional.
 */
import type { GoogleOauthApp, RefreshTokenVault } from '../src/google-oauth.ts';
import type { RecallCalendarClient, RecallCalendarEvent } from '../src/recall-calendar.ts';
import type { CreateBotArgs, RecallClient } from '../src/recall.ts';

const REDIRECT = 'https://ops.example.com/api/calendar/google/callback';

export interface Fakes {
  google: GoogleOauthApp;
  client: RecallCalendarClient;
  relayClient: RecallClient;
  vault: RefreshTokenVault & { value: string | null };
  calls: {
    exchanged: string[];
    revoked: string[];
    calendarsCreated: number;
    calendarsDeleted: string[];
    unscheduled: string[];
    botsCreated: CreateBotArgs[];
    botsLeft: string[];
  };
  events: RecallCalendarEvent[];
}

export const makeFakes = (): Fakes => {
  const calls: Fakes['calls'] = {
    exchanged: [],
    revoked: [],
    calendarsCreated: 0,
    calendarsDeleted: [],
    unscheduled: [],
    botsCreated: [],
    botsLeft: [],
  };
  const events: RecallCalendarEvent[] = [];
  return {
    calls,
    events,
    google: {
      clientId: 'fake-client-id',
      clientSecret: 'fake-client-secret',
      redirectUri: REDIRECT,
      consentUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      exchange: async (code) => {
        calls.exchanged.push(code);
        return { refreshToken: 'fake-refresh-token' };
      },
      revoke: async (token) => {
        calls.revoked.push(token);
      },
    },
    client: {
      region: 'us-east-1',
      createCalendar: async () => {
        calls.calendarsCreated += 1;
        return { id: 'cal-1', email: 'casey@example.com' };
      },
      deleteCalendar: async (id) => {
        calls.calendarsDeleted.push(id);
      },
      getEvent: async (id) => events.find((e) => e.id === id) ?? null,
      listEventsUpdatedSince: async () => events,
      listUpcoming: async () => events.filter((e) => !e.isDeleted),
      unscheduleBot: async (eventId) => {
        calls.unscheduled.push(eventId);
      },
    },
    // The bot relay's v1 client — the join goes through the SAME invite path
    // a pasted URL takes, so a configured relay is part of this suite's rig.
    relayClient: {
      config: {
        region: 'us-east-1',
        publicWsBase: 'wss://recall.example.com',
        retentionHours: 24,
        separateStreams: true,
        botName: 'Meeting Assistant',
      },
      createBot: async (args: CreateBotArgs) => {
        calls.botsCreated.push(args);
        return { id: `bot-${calls.botsCreated.length}` };
      },
      getBot: async () => {
        throw new Error('not asked in this suite');
      },
      leaveCall: async (botId: string) => {
        calls.botsLeft.push(botId);
      },
      outputAudio: async () => {},
      requestRecordingPermission: async () => false,
      checkKeyRegion: async () => ({ ok: true as const, region: 'us-east-1' as const }),
    } as RecallClient,
    vault: {
      value: null,
      save(token) {
        this.value = token;
      },
      load() {
        return this.value;
      },
      clear() {
        this.value = null;
      },
    },
  };
};
