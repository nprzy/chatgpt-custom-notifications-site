declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    SITE_ORIGIN?: string;
    VAPID_PRIVATE_JWK?: string;
    VAPID_PUBLIC_KEY?: string;
  }
}
