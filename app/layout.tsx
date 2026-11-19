import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phone Notifications",
  description: "Send custom Web Push notifications to your enrolled devices.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
