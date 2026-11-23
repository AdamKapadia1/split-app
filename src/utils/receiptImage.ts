const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT_IMAGE_PATH = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.jpg$/;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let index = 0; index < B64.length; index += 1) {
  B64_INDEX[B64.charCodeAt(index)] = index;
}

export const MAX_RECEIPT_IMAGE_BYTES = 5 * 1024 * 1024;
export const RECEIPT_IMAGE_MAX_WIDTH = 1400;
export const RECEIPT_IMAGE_JPEG_QUALITY = 0.72;

export function buildReceiptImagePath(userId: string, receiptId: string): string {
  const owner = requireUuid(userId, 'userId');
  const receipt = requireUuid(receiptId, 'receiptId');
  return `${owner}/${receipt}.jpg`;
}

export function normalizeUserId(userId: string): string {
  return requireUuid(userId, 'userId');
}

export function assertReceiptImagePath(imagePath: string): string {
  if (typeof imagePath !== 'string' || !RECEIPT_IMAGE_PATH.test(imagePath)) {
    throw new Error('Receipt image path is invalid.');
  }
  return imagePath;
}

export function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  if (typeof value !== 'string') throw new Error('Receipt image data is invalid.');

  const trimmed = value.trim();
  const payload = trimmed.toLowerCase().startsWith('data:')
    ? trimmed.slice(trimmed.indexOf(',') + 1)
    : trimmed;
  const normalized = payload.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (normalized.length === 0) return new ArrayBuffer(0);
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Receipt image data is invalid.');
  }

  const padded = normalized.length % 4 === 0
    ? normalized
    : normalized + '='.repeat(4 - (normalized.length % 4));
  const padding = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0;
  if (padding > 0 && !padded.endsWith('='.repeat(padding))) {
    throw new Error('Receipt image data is invalid.');
  }

  const byteLength = (padded.length / 4) * 3 - padding;
  if (byteLength > MAX_RECEIPT_IMAGE_BYTES) throw new Error('Receipt image is too large.');
  if (byteLength <= 0) return new ArrayBuffer(0);

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (let index = 0; index < padded.length; index += 4) {
    const c0 = padded.charCodeAt(index);
    const c1 = padded.charCodeAt(index + 1);
    const c2 = padded.charCodeAt(index + 2);
    const c3 = padded.charCodeAt(index + 3);
    const n0 = c0 < 128 ? B64_INDEX[c0] : -1;
    const n1 = c1 < 128 ? B64_INDEX[c1] : -1;
    const n2 = padded[index + 2] === '=' ? 0 : c2 < 128 ? B64_INDEX[c2] : -1;
    const n3 = padded[index + 3] === '=' ? 0 : c3 < 128 ? B64_INDEX[c3] : -1;
    if (n0 < 0 || n1 < 0 || n2 < 0 || n3 < 0) throw new Error('Receipt image data is invalid.');
    const chunk = (n0 << 18) | (n1 << 12) | (n2 << 6) | n3;
    bytes[offset] = (chunk >> 16) & 255;
    offset += 1;
    if (padded[index + 2] !== '=') {
      bytes[offset] = (chunk >> 8) & 255;
      offset += 1;
    }
    if (padded[index + 3] !== '=') {
      bytes[offset] = chunk & 255;
      offset += 1;
    }
  }

  return bytes.buffer;
}

export function assertReceiptImageByteLength(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error('Receipt image is empty.');
  }
  if (byteLength > MAX_RECEIPT_IMAGE_BYTES) {
    throw new Error('Receipt image is too large.');
  }
}

export function decodeReceiptImageBase64(value: string): ArrayBuffer {
  const buffer = decodeBase64ToArrayBuffer(value);
  assertReceiptImageByteLength(buffer.byteLength);
  return buffer;
}

function requireUuid(value: string, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a UUID.`);
  const id = value.trim().toLowerCase();
  if (!UUID.test(id) || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error(`${field} must be a UUID.`);
  }
  return id;
}
