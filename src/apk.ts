import { createHmac, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import { config } from './config.js';

const EOCD_SIGNATURE = 0x06054b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/**
 * True if the file is a zip whose central directory lists AndroidManifest.xml, i.e. really an Android package
 * and not just a file renamed to .apk. (Does not verify the signature: Android does that when installing.)
 */
export async function looksLikeApk(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size < 22) return false;

    // end-of-central-directory record sits in the last 22 + (up to 65535 comment) bytes
    const tailLength = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return false;

    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directorySize === 0 || directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > size) return false;

    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);
    return directory.includes('AndroidManifest.xml');
  } finally {
    await file.close();
  }
}

// ---- short-lived download links ------------------------------------------------------------------
// A link can be opened without logging in (so it works from a QR code on a worker's phone) but only for this one
// release and only for a few minutes. It is signed with its own key derivation, so it can never be used as an
// admin login token.

const LINK_TTL_SECONDS = 15 * 60;
const key = () => createHmac('sha256', config.JWT_SECRET).update('apk-download-link').digest();

const sign = (payload: string) => createHmac('sha256', key()).update(payload).digest('base64url');

export function createDownloadToken(releaseId: number): { token: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const payload = `${releaseId}.${exp}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000) };
}

/** Returns the release id the token is valid for, or null if it is forged, expired or malformed. */
export function verifyDownloadToken(token: string): number | null {
  const [id, exp, mac] = token.split('.');
  if (!id || !exp || !mac) return null;
  const expected = Buffer.from(sign(`${id}.${exp}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  const releaseId = Number(id);
  return Number.isInteger(releaseId) && releaseId > 0 ? releaseId : null;
}
