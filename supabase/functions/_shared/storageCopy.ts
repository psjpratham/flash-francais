// Shared storage-object copy helper — extracted from clone-public-deck's own
// inline version so syncDeckWorker.ts (which needs the exact same
// download-and-reupload-under-a-new-path behavior for a delta sync) doesn't
// maintain a second copy of it.

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = any;

/** Downloads a file and re-uploads it under a new path, in the same bucket. Throws on either failure. */
export async function copyStorageObject(admin: AnySupabaseClient, bucket: string, fromPath: string, toPath: string, contentType?: string): Promise<void> {
  const { data: blob, error: downloadError } = await admin.storage.from(bucket).download(fromPath);
  if (downloadError || !blob) throw new Error(`download_failed(${bucket}/${fromPath}): ${downloadError?.message ?? 'no data'}`);
  const { error: uploadError } = await admin.storage.from(bucket).upload(toPath, blob, { contentType: contentType ?? blob.type, upsert: true });
  if (uploadError) throw new Error(`upload_failed(${bucket}/${toPath}): ${uploadError.message}`);
}
