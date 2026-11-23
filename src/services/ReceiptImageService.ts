import { ImageManipulator, SaveFormat, manipulateAsync } from 'expo-image-manipulator';

import { supabase } from '@/lib/supabase';
import {
  RECEIPT_IMAGE_JPEG_QUALITY,
  RECEIPT_IMAGE_MAX_WIDTH,
  assertReceiptImagePath,
  buildReceiptImagePath,
  decodeReceiptImageBase64,
  normalizeUserId,
} from '@/utils/receiptImage';
import { logger } from '@/utils/logger';

const BUCKET = 'receipt-images';
const SIGNED_URL_SECONDS = 300;
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 100;

const JPEG_SAVE = {
  compress: RECEIPT_IMAGE_JPEG_QUALITY,
  format: SaveFormat.JPEG,
  base64: true,
} as const;

export { buildReceiptImagePath };

/**
 * Compresses a local photo to a JPEG, strips embedded EXIF/GPS by re-encoding,
 * and stores the bytes at `<userId>/<receiptId>.jpg` in the private bucket.
 * Returns the storage path. Never returns or logs a signed URL.
 */
export async function uploadReceiptImage(userId: string, receiptId: string, localUri: string): Promise<string> {
  const path = buildReceiptImagePath(userId, receiptId);
  const base64 = await compressReceiptJpeg(localUri);
  const bytes = decodeReceiptImageBase64(base64);
  const storage = requireBucket();
  const { error } = await storage.upload(path, bytes, {
    contentType: 'image/jpeg',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) {
    logger.warn('ReceiptImageService', { method: 'uploadReceiptImage', code: 'UPLOAD_FAILED' });
    throw new Error('Could not save the receipt photo.');
  }
  return path;
}

/**
 * Mints a 5-minute signed URL. The URL is a bearer credential and must not be
 * passed to logger.
 */
export async function getSignedReceiptImageUrl(imagePath: string): Promise<string> {
  const path = assertReceiptImagePath(imagePath);
  const storage = requireBucket();
  const { data, error } = await storage.createSignedUrl(path, SIGNED_URL_SECONDS);
  const signedUrl = data?.signedUrl;
  if (error || !signedUrl) {
    logger.warn('ReceiptImageService', { method: 'getSignedReceiptImageUrl', code: 'SIGN_FAILED' });
    throw new Error('Could not open the receipt photo.');
  }
  return signedUrl;
}

export async function deleteReceiptImage(imagePath: string): Promise<void> {
  const path = assertReceiptImagePath(imagePath);
  const storage = requireBucket();
  const { error } = await storage.remove([path]);
  if (error) {
    logger.warn('ReceiptImageService', { method: 'deleteReceiptImage', code: 'DELETE_FAILED' });
    throw new Error('Could not delete the receipt photo.');
  }
}

/**
 * Deletes every receipt JPEG stored under this user's folder. Uses the Storage
 * API, never a direct delete from storage.objects. An empty folder is success.
 */
export async function purgeAllUserReceiptImages(userId: string): Promise<void> {
  const folder = normalizeUserId(userId);
  const storage = requireBucket();
  const paths: string[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { data, error } = await storage.list(folder, {
      limit: LIST_PAGE_SIZE,
      offset: page * LIST_PAGE_SIZE,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) {
      if (isMissingFolder(error)) return;
      logger.warn('ReceiptImageService', { method: 'purgeAllUserReceiptImages', code: 'LIST_FAILED' });
      throw new Error('Could not delete the receipt photos.');
    }
    if (!data || data.length === 0) break;

    let fresh = 0;
    for (const entry of data) {
      if (!entry?.name || seen.has(entry.name)) continue;
      seen.add(entry.name);
      fresh += 1;
      const candidate = `${folder}/${entry.name}`;
      if (isStoredReceiptImage(candidate)) paths.push(candidate);
    }
    if (fresh === 0) break;
    if (data.length < LIST_PAGE_SIZE) break;
  }

  for (let index = 0; index < paths.length; index += LIST_PAGE_SIZE) {
    const batch = paths.slice(index, index + LIST_PAGE_SIZE);
    const { error } = await storage.remove(batch);
    if (error) {
      logger.warn('ReceiptImageService', { method: 'purgeAllUserReceiptImages', code: 'REMOVE_FAILED' });
      throw new Error('Could not delete the receipt photos.');
    }
  }
}

async function compressReceiptJpeg(localUri: string): Promise<string> {
  const uri = typeof localUri === 'string' ? localUri.trim() : '';
  if (!uri) throw new Error('Receipt photo is missing.');

  if (typeof ImageManipulator?.manipulate === 'function') {
    try {
      return await compressWithContext(uri);
    } catch {
      logger.warn('ReceiptImageService', { method: 'compressReceiptJpeg', code: 'MANIPULATOR_FALLBACK' });
    }
  }

  try {
    const saved = await manipulateAsync(
      uri,
      [{ resize: { width: RECEIPT_IMAGE_MAX_WIDTH } }],
      JPEG_SAVE,
    );
    if (!saved.base64) throw new Error('Could not compress the receipt photo.');
    return saved.base64;
  } catch (error) {
    if (error instanceof Error && error.message === 'Could not compress the receipt photo.') throw error;
    logger.warn('ReceiptImageService', { method: 'compressReceiptJpeg', code: 'COMPRESS_FAILED' });
    throw new Error('Could not compress the receipt photo.');
  }
}

async function compressWithContext(uri: string): Promise<string> {
  const context = ImageManipulator.manipulate(uri, { maxWidth: RECEIPT_IMAGE_MAX_WIDTH });
  let image = await context.renderAsync();
  if (image.width > RECEIPT_IMAGE_MAX_WIDTH) {
    context.reset().resize({ width: RECEIPT_IMAGE_MAX_WIDTH });
    image = await context.renderAsync();
  }
  const saved = await image.saveAsync(JPEG_SAVE);
  if (!saved.base64) throw new Error('Could not compress the receipt photo.');
  return saved.base64;
}

function requireBucket() {
  if (!supabase) throw new Error('Supabase is not configured.');
  return supabase.storage.from(BUCKET);
}

function isStoredReceiptImage(candidate: string): boolean {
  try {
    assertReceiptImagePath(candidate);
    return true;
  } catch {
    return false;
  }
}

function isMissingFolder(error: { message?: string; statusCode?: string | number }) {
  const status = String(error.statusCode ?? '');
  if (status === '404') return true;
  return /not found|does not exist/i.test(error.message ?? '');
}
