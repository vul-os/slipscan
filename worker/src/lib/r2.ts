/**
 * Object storage via the R2 binding (replaces the Go S3 client in
 * internal/storage). put/get use env.DOCS directly — no keys needed. Presigned
 * downloads are served by proxying through the Worker (added with the
 * documents module) rather than S3 presigned URLs.
 *
 * Key convention (matches Go): documents/<orgId>/<docId>.<ext>,
 * inbound/<orgId>/<messageId>.eml
 */
import type { Env } from "../bindings";

export async function putObject(
  env: Env,
  key: string,
  data: ArrayBuffer | Uint8Array | string,
  contentType: string,
): Promise<void> {
  await env.DOCS.put(key, data, { httpMetadata: { contentType } });
}

export async function getObject(env: Env, key: string): Promise<Uint8Array | null> {
  const obj = await env.DOCS.get(key);
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.DOCS.delete(key);
}
