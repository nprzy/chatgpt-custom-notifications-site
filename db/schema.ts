import { foreignKey, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  endpoint: text("endpoint").notNull(),
  subscription: text("subscription").notNull(),
  revision: text("revision").notNull(),
  enrolledAt: integer("enrolled_at").notNull(),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
}, (table) => [unique().on(table.userId, table.endpoint)]);

export const notificationEvents = sqliteTable("notification_events", {
  userId: text("user_id").notNull(),
  eventId: text("event_id").notNull(),
  attempt: text("attempt").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.eventId] })]);

export const notificationDeliveries = sqliteTable("notification_deliveries", {
  userId: text("user_id").notNull(),
  eventId: text("event_id").notNull(),
  deviceId: text("device_id").notNull(),
  revision: text("revision").notNull(),
  attempt: text("attempt"),
}, (table) => [
  primaryKey({ columns: [table.userId, table.eventId, table.deviceId] }),
  foreignKey({
    columns: [table.userId, table.eventId],
    foreignColumns: [notificationEvents.userId, notificationEvents.eventId],
  }).onDelete("cascade"),
]);
