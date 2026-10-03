/**
 * The receiving half of Web Push encryption (RFC 8291 over RFC 8188
 * `aes128gcm`), for a test that has to read what a notification says. It is
 * the browser's side, written from the RFC rather than from `push-crypto.ts`,
 * and `push-crypto.test.ts` holds the RFC vector both halves are measured by.
 */
import { b64urlEncode } from '../src/push-crypto.ts';

const text = new TextEncoder();

/** A device: its subscription for the server, and its keys for reading. */
export async function pushDevice(endpoint: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint,
    keys: { p256dh: b64urlEncode(publicKey), auth: b64urlEncode(auth) },
  };
  return { subscription, privateKey: pair.privateKey, publicKey, auth };
}

type Bytes = Uint8Array<ArrayBuffer>;

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** The plaintext of one `aes128gcm` body sent to `device`. */
export async function decryptPush(
  device: Awaited<ReturnType<typeof pushDevice>>,
  body: Bytes,
): Promise<string> {
  const salt = body.slice(0, 16);
  const idLen = body[20] ?? 0;
  const senderKey = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  const sender = await crypto.subtle.importKey(
    'raw',
    senderKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, device.privateKey, 256),
  );
  const keyInfo = new Uint8Array([
    ...text.encode('WebPush: info\0'),
    ...device.publicKey,
    ...senderKey,
  ]);
  const ikm = await hkdf(device.auth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher),
  );
  // The last record ends with a 0x02 delimiter and any zero padding.
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  return new TextDecoder().decode(plain.slice(0, end));
}
