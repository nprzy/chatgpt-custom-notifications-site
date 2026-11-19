import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getDb } from "../../../db";
import { devices } from "../../../db/schema";
import { configuredPush, isSiteRequest, json } from "../../../lib/notifications";
import { subscriptionSchema } from "../../../lib/push-subscription";

const nameSchema = z.string().trim().min(1).max(60);
const idSchema = z.string().uuid();
const enrollmentSchema = z.object({ name: nameSchema, subscription: subscriptionSchema });
const changeSchema = z.union([
  z.object({ id: idSchema, name: nameSchema }).strict(),
  z.object({ id: idSchema, paused: z.boolean() }).strict(),
]);

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ message: "Sign in to manage your devices." }, 401);
  const entries = await getDb().select({
    id: devices.id, name: devices.name, enrolledAt: devices.enrolledAt, paused: devices.paused,
  }).from(devices).where(eq(devices.userId, user.userId)).orderBy(asc(devices.enrolledAt), asc(devices.id));
  return json({
    devices: entries,
    publicKey: (await configuredPush())?.publicKey ?? null,
  });
}

export async function PUT(request: Request) {
  if (!isSiteRequest(request)) return json({ message: "Open the published Site directly." }, 403);
  const user = await getChatGPTUser();
  if (!user) return json({ message: "Sign in to enroll your device." }, 401);
  if (!await configuredPush()) return json({ message: "Set SITE_ORIGIN and a valid matching VAPID key pair in the Site settings." }, 503);
  const enrollment = enrollmentSchema.safeParse(await request.json().catch(() => null));
  if (!enrollment.success) {
    const invalidEndpoint = enrollment.error.issues.some(({ path }) => path.join(".") === "subscription.endpoint");
    return json({ message: invalidEndpoint
      ? "This browser’s push service isn’t supported by the Site. Try Chrome or Firefox."
      : "Enter a device name and try enrolling again in a browser that supports Web Push." }, 400);
  }
  const { name, subscription } = enrollment.data;
  const serialized = JSON.stringify(subscription);
  const revision = crypto.randomUUID();
  const [result] = await getDb().insert(devices).values({
    id: crypto.randomUUID(), userId: user.userId, name,
    endpoint: subscription.endpoint, subscription: serialized, revision, enrolledAt: Date.now(),
  }).onConflictDoUpdate({
    target: [devices.userId, devices.endpoint],
    set: {
      name,
      subscription: serialized,
      revision: sql`case when ${devices.subscription} = ${serialized} then ${devices.revision} else ${revision} end`,
    },
  }).returning({ id: devices.id, name: devices.name, paused: devices.paused });
  return json(result);
}

export async function PATCH(request: Request) {
  if (!isSiteRequest(request)) return json({ message: "Open the published Site directly." }, 403);
  const user = await getChatGPTUser();
  if (!user) return json({ message: "Sign in to manage your devices." }, 401);
  const change = changeSchema.safeParse(await request.json().catch(() => null));
  if (!change.success) return json({ message: "Choose a device and a valid change." }, 400);
  const { id } = change.data;
  const updates = "name" in change.data ? { name: change.data.name } : {
    paused: change.data.paused,
    revision: sql`case when ${devices.paused} = ${Number(change.data.paused)} then ${devices.revision} else ${crypto.randomUUID()} end`,
  };
  const [result] = await getDb().update(devices).set(updates)
    .where(and(eq(devices.userId, user.userId), eq(devices.id, id)))
    .returning({ id: devices.id });
  return result ? json(result) : json({ message: "This device is no longer enrolled." }, 404);
}

export async function DELETE(request: Request) {
  if (!isSiteRequest(request)) return json({ message: "Open the published Site directly." }, 403);
  const user = await getChatGPTUser();
  if (!user) return json({ message: "Sign in to manage your devices." }, 401);
  const removal = z.object({ id: idSchema }).safeParse(await request.json().catch(() => null));
  if (!removal.success) return json({ message: "Choose a device to remove." }, 400);
  await getDb().delete(devices).where(and(eq(devices.userId, user.userId), eq(devices.id, removal.data.id)));
  return json({ id: removal.data.id });
}
