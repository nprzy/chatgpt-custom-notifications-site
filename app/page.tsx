import { requireChatGPTUser } from "./chatgpt-auth";
import { NotificationControls } from "./notification-controls";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireChatGPTUser("/");
  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-icon" aria-hidden="true"><BellIcon /></span> Phone Notifications</div>
        <span className="private-label">Private Site</span>
      </header>
      <section className="hero">
        <div>
          <h1>Phone notifications</h1>
          <p>Send custom alerts from ChatGPT to your enrolled devices.</p>
        </div>
      </section>
      <NotificationControls />
      <footer>
        ChatGPT tool <code>send_user_notification</code>
      </footer>
    </main>
  );
}

function BellIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>;
}
