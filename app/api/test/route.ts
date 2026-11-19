import { z } from "zod";
import { getChatGPTUser } from "../../chatgpt-auth";
import { isSiteRequest, json, notificationInput, sendNotification } from "../../../lib/notifications";

const testInput = notificationInput.omit({ event_id: true }).extend({ deviceId: z.string().uuid().optional() });

export async function POST(request: Request) {
  if (!isSiteRequest(request)) return json({ message: "Open the published Site directly." }, 403);
  const user = await getChatGPTUser();
  if (!user) return json({ message: "Sign in to send a test." }, 401);
  const input = testInput.safeParse(await request.json().catch(() => null));
  if (!input.success) return json({ message: "Enter a title and message within the character limits." }, 400);
  const { deviceId, ...message } = input.data;
  const result = await sendNotification(user.userId, message, deviceId);
  return json({ message: result.message }, result.status);
}
