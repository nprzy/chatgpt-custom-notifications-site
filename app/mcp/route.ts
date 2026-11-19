import { z } from "zod";
import { json, notificationInput, sendNotification } from "../../lib/notifications";

const tool = {
  name: "send_user_notification",
  description: "Send a Web Push notification to every active device enrolled by the current user using the supplied title and body. Use only when the user requests a send or an authorized monitoring condition is met. A successful send means the push service accepted the request.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 120, description: "Notification title." },
      body: { type: "string", minLength: 1, maxLength: 700, description: "Notification message." },
      event_id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_.:/-]+$", description: "Optional stable ID for a monitoring event. Use the same ID and original title and body on retries. Deduplicated per device for 30 days." },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.object({ name: z.string().optional(), arguments: z.unknown() }).optional(),
});

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

export async function POST(request: Request) {
  const parsed = rpcRequest.safeParse(await request.json().catch(() => null));
  const id = parsed.data?.id ?? null;
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => json({ jsonrpc: "2.0", id, error: { code, message } });

  if (!parsed.success) return error(-32600, "Invalid request");
  const rpc = parsed.data;
  if (rpc.method === "server/discover") {
    return reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
  }
  if (rpc.method === "tools/list") return reply({ tools: [tool] });
  if (rpc.method !== "tools/call") return error(-32601, "Method not found");
  if (rpc.params?.name !== tool.name) return error(-32602, "Unknown tool");
  const userId = request.headers.get("oai-authenticated-user-id");
  if (!userId) return reply(toolResult("Connect the Phone Notifications plugin with your ChatGPT account.", true));
  const input = notificationInput.safeParse(rpc.params?.arguments);
  if (!input.success) return reply(toolResult("Provide a title and body within the character limits, and a valid event ID if needed.", true));
  try {
    const result = await sendNotification(userId, input.data);
    return reply(toolResult(result.message, result.status >= 400));
  } catch {
    return reply(toolResult("The Site could not complete the send request.", true));
  }
}
