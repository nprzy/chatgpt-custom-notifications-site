import { z } from "zod";

const base64url = /^[A-Za-z0-9_-]+$/;
const providerPaths = new Map([
  ["https://fcm.googleapis.com", /^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:\-.~%]+$/],
  ["https://updates.push.services.mozilla.com", /^\/wpush\/v[12]\/[A-Za-z0-9_-]+={0,2}$/],
]);

export const subscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash
        && (providerPaths.get(url.origin)?.test(url.pathname) ?? false);
    } catch {
      return false;
    }
  }),
  expirationTime: z.number().nullable().default(null),
  keys: z.object({
    p256dh: z.string().length(87).regex(base64url),
    auth: z.string().length(22).regex(base64url),
  }),
});
