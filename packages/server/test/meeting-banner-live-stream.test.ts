/**
 * The meeting banner on an open workspaces list hears a meeting start and
 * end without polling: a join taken or withdrawn on any device sends a
 * `landing.changed` frame naming `meeting`, and the banner re-reads the
 * events list (`packages/workspaces-app/src/landing-live.ts`).
 *
 * The calendar is linked by seeding the connection file the store reads at
 * boot, so the Google flow is not part of this rig. All fixtures are
 * invented. Port 0, temp data dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { makeFakes } from './calendar-fakes.ts';
import { landingFrames } from './landing-frames.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

describe('the meeting banner on an open workspaces list', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let WS = '';

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meeting-live-'));
    mkdirSync(join(dataDir, 'calendar'), { recursive: true });
    writeFileSync(
      join(dataDir, 'calendar', 'google.json'),
      JSON.stringify({
        connection: { calendarId: 'cal-1', email: null, connectedAt: 1 },
        joins: {},
      }),
    );
    const fakes = makeFakes();
    fakes.events.push({
      id: 'evt-harborlight',
      title: 'Harborlight sync',
      startTime: '2026-10-08T15:00:00Z',
      endTime: '2026-10-08T15:30:00Z',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      isDeleted: false,
      botsScheduled: 0,
    });
    handle = createServer({
      port: 0,
      dataDir,
      meetingBot: fakes.relayClient,
      calendarBot: { client: fakes.client, google: fakes.google, vault: fakes.vault },
    });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base, { name: 'Riverbend' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const join_ = (join: boolean) =>
    fetch(`${base}/workspaces/${WS}/calendar/events/evt-harborlight/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ join }),
    });

  it('hears a join taken and withdrawn elsewhere', async () => {
    const feed = landingFrames(await fetch(`${base}/landing/events:stream`));
    try {
      expect((await join_(true)).status).toBe(200);
      await waitFor(() => feed.parts().has('meeting'), { describe: 'a frame for the join' });
      feed.parts().clear();
      expect((await join_(false)).status).toBe(200);
      await waitFor(() => feed.parts().has('meeting'), { describe: 'a frame for the leave' });
    } finally {
      feed.stop();
    }
  });
});
