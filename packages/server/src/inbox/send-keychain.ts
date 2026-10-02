/**
 * The credentials Bryan's Send posts with, and the only code that reads
 * them. They live in the macOS Keychain, one service per source, one
 * account per value:
 *
 *   claude-workspaces-inbox-gmail   client-id, client-secret, refresh-token
 *                                   (an OAuth client of Bryan's own, and a
 *                                   refresh token granted `gmail.send` and
 *                                   `gmail.metadata`)
 *   claude-workspaces-inbox-slack   one account per Slack workspace key in
 *                                   the inbox config, holding that team's
 *                                   user token (`xoxp-`, `chat:write`)
 *
 * The reader session never reaches this file: its one verb posts rows. No
 * value read here is logged, returned to a route or kept on disk; the Gmail
 * access token it mints is held in memory until it expires.
 *
 * `has` asks `security` whether an entry exists without `-w`, so
 * the page can say whether Send is set up without the secret entering this
 * process.
 */
import { type KeychainRunner, readKeychainAccountPassword } from '../share/keychain.ts';

export const GMAIL_SEND_SERVICE = 'claude-workspaces-inbox-gmail';
export const SLACK_SEND_SERVICE = 'claude-workspaces-inbox-slack';
export const GMAIL_ACCOUNTS = ['client-id', 'client-secret', 'refresh-token'] as const;

export interface SendKeychain {
  has(service: string, account: string): boolean;
  read(service: string, account: string): string | null;
}

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
