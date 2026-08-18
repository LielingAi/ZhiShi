// Inbound image payload types (relocated from server/runtimes/types.ts, D20)

/**
 * Image payload from frontend (base64-encoded)
 */
export interface ImagePayload {
  name: string;
  mimeType: string;
  data: string;  // base64 without data URL prefix
}
