self.addEventListener("push", (event) => {
  if (!event.data) return;
  const { title, body } = event.data.json();
  if (typeof title !== "string" || typeof body !== "string") return;
  event.waitUntil(self.registration.showNotification(title, { body, icon: "/favicon.svg" }));
});
