/**
 * The credentials Bryan's Send posts with, and the only code that reads
 * them. They live in the macOS Keychain in one of two places.
 *
 * The secret card on the inbox task, where Bryan saves them. Each value is
 * its own entry, stored BASE64 under service `claude-workspaces-secret.<name>`,
 * account `claude-workspaces` (`core/secret-name.ts`):
 *
 *   inbox-gmail-client-id, inbox-gmail-client-secret, inbox-gmail-refresh-token
 *       an OAuth client of Bryan's own, and a refresh token granted
 *       `gmail.send` and `gmail.metadata`
 *   inbox-slack-token-1, inbox-slack-token-2
 *       up to two Slack user tokens (`xoxp-`, `chat:write`); the card does
 *       not know which workspace each is for, so `send-slack.ts` asks Slack
 *
 * The older raw entries, read when the card has no answer:
 *
 *   claude-workspaces-inbox-gmail   client-id, client-secret, refresh-token
 *   claude-workspaces-inbox-slack   one account per Slack workspace key in
 *                                   the inbox config, holding that team's
 *                                   user token
 *
 * Gmail takes the card's three values only when all three are there, and
 * otherwise the raw three, so a client id is never paired with another
 * client's secret.
 *
 * The reader session never reaches this file: its one verb posts rows. No
 * value read here is logged, returned to a route or kept on disk; the Gmail
 * access token it mints is held in memory until it expires.
 *
 * `has` asks `security` whether an entry exists without `-w`, so
 * the page can say whether Send is set up without the secret entering this
 * process.
 */
import { SECRET_ACCOUNT, storedSecretService } from '@claude-workspaces/core/secret-name';
import { type KeychainRunner, readKeychainAccountPassword } from '../share/keychain.ts';

export const GMAIL_SEND_SERVICE = 'claude-workspaces-inbox-gmail';
export const SLACK_SEND_SERVICE = 'claude-workspaces-inbox-slack';
export const GMAIL_ACCOUNTS = ['client-id', 'client-secret', 'refresh-token'] as const;

/** The card names, in `GMAIL_ACCOUNTS` order. */
export const GMAIL_CARD_NAMES = [
  'inbox-gmail-client-id',
  'inbox-gmail-client-secret',
  'inbox-gmail-refresh-token',
] as const;
export const SLACK_CARD_TOKENS = ['inbox-slack-token-1', 'inbox-slack-token-2'] as const;

export interface SendKeychain {
  has(service: string, account: string): boolean;
  read(service: string, account: string): string | null;
}

export const cardHas = (k: SendKeychain, name: string): boolean =>
  k.has(storedSecretService(name), SECRET_ACCOUNT);

/** A card value, decoded, or null. Not `atob`: a stray character must give
 *  null rather than an error that could quote the value. */
export function cardRead(k: SendKeychain, name: string): string | null {
  const stored = k.read(storedSecretService(name), SECRET_ACCOUNT);
  if (!stored) return null;
  return Buffer.from(stored.trim(), 'base64').toString('utf8').trim() || null;
}

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const asCredentials = (v: (string | null)[]): GmailCredentials | null => {
  const [clientId, clientSecret, refreshToken] = v;
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
};

/** The card's three values, else the raw three, else null. */
export function gmailCredentials(k: SendKeychain): GmailCredentials | null {
  return (
    asCredentials(GMAIL_CARD_NAMES.map((n) => cardRead(k, n))) ??
    asCredentials(GMAIL_ACCOUNTS.map((a) => k.read(GMAIL_SEND_SERVICE, a)))
  );
}

export const gmailReady = (k: SendKeychain): boolean =>
  GMAIL_CARD_NAMES.every((n) => cardHas(k, n)) ||
  GMAIL_ACCOUNTS.every((a) => k.has(GMAIL_SEND_SERVICE, a));

export function keychainFor(run: KeychainRunner): SendKeychain {
  return {
    has: (service, account) =>
      run(['find-generic-password', '-a', account, '-s', service]).status === 0,
    read: (service, account) => readKeychainAccountPassword(service, account, run),
  };
}

/** The default: the real `security` binary, existence asked without `-w`. */
export function systemKeychain(): SendKeychain {
  return keychainFor(spawnRunner);
}

/** No `security` binary (any host but a Mac) reads as no entry. */
function spawnRunner(args: string[]): { status: number | null; stdout: string } {
  try {
    const proc = Bun.spawnSync(['security', ...args], { stdout: 'pipe', stderr: 'ignore' });
    return { status: proc.exitCode, stdout: proc.stdout ? proc.stdout.toString() : '' };
  } catch {
    return { status: null, stdout: '' };
  }
}
