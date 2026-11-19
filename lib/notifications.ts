import { env } from "cloudflare:workers";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { and, eq, exists, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import { devices, notificationDeliveries, notificationEvents } from "../db/schema";
import { subscriptionSchema } from "./push-subscription";

export const notificationInput = z.object({
  title: z.string().min(1).max(120).refine((value) => value.trim().length > 0),
  body: z.string().min(1).max(700).refine((value) => value.trim().length > 0),
  event_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:/-]+$/).optional(),
}).strict();

type NotificationInput = z.infer<typeof notificationInput>;

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function configuredSiteOrigin() {
  if (!env.SITE_ORIGIN) return null;
  try {
    const url = new URL(env.SITE_ORIGIN);
    return url.protocol === "https:" && url.href === `${url.origin}/` ? url.origin : null;
  } catch {
    return null;
  }
}

export function isSiteRequest(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && (origin === configuredSiteOrigin()
    || (import.meta.env.DEV && origin === new URL(request.url).origin));
}

type Device = typeof devices.$inferSelect;
type Db = ReturnType<typeof getDb>;
type PushConfig = { subject: string; publicKey: string; privateKey: string };
const payloadLimit = 3993;
const encoder = new TextEncoder();
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const privateJwk = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: coordinate,
  y: coordinate,
  d: coordinate,
});

function decodeBase64url(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding), (byte) => byte.charCodeAt(0));
}

export async function configuredPush(): Promise<PushConfig | null> {
  const subject = configuredSiteOrigin();
  const publicKey = env.VAPID_PUBLIC_KEY;
  if (!subject || !publicKey || !/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !env.VAPID_PRIVATE_JWK) return null;
  try {
    const jwk = privateJwk.parse(JSON.parse(env.VAPID_PRIVATE_JWK));
    const bytes = decodeBase64url(publicKey);
    if (bytes[0] !== 4
      || !decodeBase64url(jwk.x).every((byte, index) => byte === bytes[index + 1])
      || !decodeBase64url(jwk.y).every((byte, index) => byte === bytes[index + 33])) return null;

    const algorithm = { name: "ECDSA", namedCurve: "P-256" };
    const [signingKey, verificationKey] = await Promise.all([
      crypto.subtle.importKey("jwk", jwk, algorithm, false, ["sign"]),
      crypto.subtle.importKey("raw", bytes, algorithm, false, ["verify"]),
    ]);
    const signatureAlgorithm = { name: "ECDSA", hash: "SHA-256" };
    const challenge = new Uint8Array(0);
    const signature = await crypto.subtle.sign(signatureAlgorithm, signingKey, challenge);
    if (!await crypto.subtle.verify(signatureAlgorithm, verificationKey, signature, challenge)) return null;
    return { subject, publicKey, privateKey: jwk.d };
  } catch {
    return null;
  }
}
type DeliveryOutcome = "accepted" | "duplicate" | "skipped" | "expired" | "rejected" | "unknown";

function deviceMatches(device: Device) {
  return and(eq(devices.userId, device.userId), eq(devices.id, device.id), eq(devices.revision, device.revision));
}

async function recipientsForEvent(db: Db, userId: string, eventId: string, payloadDigest: string) {
  const now = Date.now();
  const attempt = crypto.randomUUID();
  const eventKey = and(eq(notificationEvents.userId, userId), eq(notificationEvents.eventId, eventId));
  const [, created, , [event], recipients] = await db.batch([
    db.delete(notificationEvents).where(and(
      eq(notificationEvents.userId, userId), lte(notificationEvents.expiresAt, now),
    )),
    db.insert(notificationEvents).values({
      userId, eventId, attempt, payloadDigest, expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    }).onConflictDoNothing().returning({ attempt: notificationEvents.attempt }),
    // Freeze this event's recipients at first send. Paused devices and later
    // enrollments cannot get a past alert when the caller retries.
    db.insert(notificationDeliveries).select(db.select({
      userId: devices.userId,
      eventId: notificationEvents.eventId,
      deviceId: devices.id,
      revision: devices.revision,
      attempt: sql<string | null>`null`.as("pending_attempt"),
    }).from(devices).innerJoin(notificationEvents, eq(notificationEvents.userId, devices.userId))
      .where(and(eventKey, eq(devices.paused, false), eq(notificationEvents.attempt, attempt)))),
    db.select({ attempt: notificationEvents.attempt, digest: notificationEvents.payloadDigest })
      .from(notificationEvents).where(eventKey),
    db.select({ device: devices }).from(notificationDeliveries).innerJoin(devices, and(
      eq(devices.id, notificationDeliveries.deviceId),
      eq(devices.userId, notificationDeliveries.userId),
      eq(devices.revision, notificationDeliveries.revision),
    )).where(and(
      eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.eventId, eventId),
      eq(devices.paused, false),
    )),
  ]);
  if (event.digest !== payloadDigest) return null;
  return { attempt: event.attempt, created: created.length > 0, devices: recipients.map(({ device }) => device) };
}

async function deliver(
  db: Db, device: Device, message: string, vapid: PushConfig,
  event?: { id: string; attempt: string },
): Promise<DeliveryOutcome> {
  const recipient = event ? and(
    eq(notificationDeliveries.userId, device.userId), eq(notificationDeliveries.eventId, event.id),
    eq(notificationDeliveries.deviceId, device.id), eq(notificationDeliveries.revision, device.revision),
    exists(db.select({ attempt: notificationEvents.attempt }).from(notificationEvents).where(and(
      eq(notificationEvents.userId, device.userId), eq(notificationEvents.eventId, event.id),
      eq(notificationEvents.attempt, event.attempt),
    ))),
  ) : undefined;
  const attempt = crypto.randomUUID();

  if (recipient) {
    const [claim] = await db.update(notificationDeliveries).set({ attempt })
      .where(and(recipient, isNull(notificationDeliveries.attempt)))
      .returning({ deviceId: notificationDeliveries.deviceId });
    if (!claim) return "duplicate";
  }

  let payload: Awaited<ReturnType<typeof buildPushPayload>>;
  let endpoint: string;
  try {
    const subscription = subscriptionSchema.parse(JSON.parse(device.subscription));
    endpoint = subscription.endpoint;
    payload = await buildPushPayload({
      data: message,
      options: { ttl: 300 },
    }, subscription, vapid);
  } catch {
    if (recipient) await db.update(notificationDeliveries).set({ attempt: null })
      .where(and(recipient, eq(notificationDeliveries.attempt, attempt)));
    return "rejected";
  }

  // A pause/resume cycle or subscription change invalidates the saved revision.
  const eligible = await db.select({ id: devices.id }).from(devices)
    .where(and(deviceMatches(device), eq(devices.paused, false))).get();
  if (!eligible) return "skipped";

  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...payload,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A transport error is ambiguous. Retain this claim to avoid a duplicate.
    return "unknown";
  }
  if (response.ok) return "accepted";

  if (response.status === 404 || response.status === 410) {
    await db.delete(devices).where(deviceMatches(device));
    return "expired";
  }
  if (recipient) await db.update(notificationDeliveries).set({ attempt: null })
    .where(and(recipient, eq(notificationDeliveries.attempt, attempt)));
  return "rejected";
}

export async function sendNotification(userId: string, input: NotificationInput, testDeviceId?: string) {
  const message = JSON.stringify({ title: input.title, body: input.body });
  const bytes = encoder.encode(message);
  if (bytes.length > payloadLimit) {
    return { status: 400, message: `The notification is ${bytes.length} bytes after JSON encoding. Shorten the title or body to fit the ${payloadLimit.toLocaleString("en-US")}-byte limit.` };
  }

  const vapid = await configuredPush();
  if (!vapid) return { status: 503, message: "Set SITE_ORIGIN and a valid matching VAPID key pair in the Site settings." };

  const db = getDb();
  let event: Awaited<ReturnType<typeof recipientsForEvent>> | undefined;
  if (input.event_id) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    event = await recipientsForEvent(db, userId, input.event_id, digest);
    if (!event) return { status: 409, message: "This event ID already has a different title or body. Retry with the original text or use a new event ID for a new notification." };
  }
  const recipients = event ? event.devices : await db.select().from(devices).where(and(
    eq(devices.userId, userId), eq(devices.paused, false),
    testDeviceId ? eq(devices.id, testDeviceId) : undefined,
  ));
  if (!recipients.length) {
    if (event && !event.created) return { status: 200, message: "This event has no new eligible deliveries." };
    return { status: 409, message: testDeviceId
      ? "The selected device is paused or no longer enrolled."
      : `No active devices are enrolled. Open ${vapid.subject} to enroll a device or resume a paused device.` };
  }

  const deliveryEvent = event && input.event_id ? { id: input.event_id, attempt: event.attempt } : undefined;
  const outcomes: DeliveryOutcome[] = [];
  for (let index = 0; index < recipients.length; index += 4) {
    const batch = await Promise.allSettled(recipients.slice(index, index + 4)
      .map((device) => deliver(db, device, message, vapid, deliveryEvent)));
    outcomes.push(...batch.map((result) => result.status === "fulfilled" ? result.value : "unknown"));
  }
  const count = (outcome: DeliveryOutcome) => outcomes.filter((value) => value === outcome).length;
  const accepted = count("accepted");
  const rejected = count("rejected");
  const unknown = count("unknown");
  const expired = count("expired");
  const skipped = count("skipped");
  const duplicates = count("duplicate");
  const deviceCount = (total: number) => `${total} ${total === 1 ? "device" : "devices"}`;
  const messages = [
    accepted && `The push service accepted the notification for ${deviceCount(accepted)}.`,
    rejected && `Sending failed for ${deviceCount(rejected)}.${input.event_id ? " Retry using the same event ID." : ""}`,
    unknown && `Delivery could not be confirmed for ${deviceCount(unknown)}.`,
    expired && `Removed ${deviceCount(expired)} with expired subscriptions.`,
    skipped && `Skipped ${deviceCount(skipped)} whose enrollment changed.`,
    duplicates && `Skipped ${deviceCount(duplicates)} already attempted for this event.`,
  ].filter(Boolean);
  const status = rejected || unknown ? 502 : accepted || duplicates ? 200 : 409;
  return { status, message: messages.join(" ") };
}
