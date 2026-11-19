"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

type Device = { id: string; name: string; enrolledAt: number; paused: boolean };
type DeviceList = { devices: Device[]; publicKey: string | null };
type Feedback = { text: string; error?: boolean };

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) {
    const message = result && typeof result === "object" && "message" in result ? result.message : null;
    throw new Error(typeof message === "string" ? message : "The request failed. Refresh the page and try again.");
  }
  return result as T;
}

function subscribeKey(publicKey: string) {
  return Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "="), (char) => char.charCodeAt(0));
}

function canEnrollBrowser() {
  return window.top === window.self && window.isSecureContext
    && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function enrollBrowser(publicKey: string) {
  if (!canEnrollBrowser()) throw new Error("Open the Site directly in a browser that supports Web Push.");
  if (await Notification.requestPermission() !== "granted") {
    throw new Error("Allow notifications for this Site in your browser’s settings, then try again.");
  }
  await navigator.serviceWorker.register("/phone-push-sw.js", { scope: "/" });
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("Your browser couldn’t start the notification service. Refresh and try again.")), 10_000);
    }),
  ]);
  const key = subscribeKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const existingKey = new Uint8Array(subscription.options.applicationServerKey ?? new ArrayBuffer(0));
    if (existingKey.length !== key.length || existingKey.some((byte, index) => byte !== key[index])) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  return subscription ?? registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

function errorFeedback(error: unknown, fallback: string): Feedback {
  return { text: error instanceof Error ? error.message : fallback, error: true };
}

export function NotificationControls() {
  const [state, setState] = useState<DeviceList | null>(null);
  const [canEnroll, setCanEnroll] = useState<boolean | null>(null);
  const [working, setWorking] = useState(false);
  const [deviceFeedback, setDeviceFeedback] = useState<Feedback | null>(null);
  const [sendFeedback, setSendFeedback] = useState<Feedback | null>(null);
  const [name, setName] = useState("");
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [testDevice, setTestDevice] = useState("");
  const [title, setTitle] = useState("Phone notifications are ready");
  const [body, setBody] = useState("You received a test from your private notification Site.");

  const latestRefresh = useRef(0);
  const refreshDevices = useCallback(async () => {
    const sequence = ++latestRefresh.current;
    const devices = await api<DeviceList>("/api/device");
    if (sequence === latestRefresh.current) setState(devices);
  }, []);

  useEffect(() => {
    setCanEnroll(canEnrollBrowser());
    function load() {
      refreshDevices().catch(() => setDeviceFeedback({ text: "The device list couldn’t load. Refresh to try again.", error: true }));
    }
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [refreshDevices]);

  const devices = state?.devices ?? [];
  const activeDevices = devices.filter((device) => !device.paused);
  const testTarget = activeDevices.some((device) => device.id === testDevice) ? testDevice : "";

  async function enable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state?.publicKey || working || !name.trim()) return;
    setWorking(true);
    setDeviceFeedback(null);
    try {
      const subscription = await enrollBrowser(state.publicKey);
      const result = await api<Device>("/api/device", "PUT", { name, subscription: subscription.toJSON() });
      setName("");
      await refreshDevices();
      setDeviceFeedback({ text: result.paused
        ? `${result.name} is enrolled and stays paused until you resume it.`
        : `${result.name} is enrolled and ready to receive notifications.` });
    } catch (error) {
      setDeviceFeedback(errorFeedback(error, "Enrollment failed. Try again."));
    } finally {
      setWorking(false);
    }
  }

  async function manage(method: "PATCH" | "DELETE", change: { id: string; name?: string; paused?: boolean }, message: string) {
    if (working) return;
    setWorking(true);
    setDeviceFeedback(null);
    try {
      await api("/api/device", method, change);
      setRename(null);
      setRemoving(null);
      await refreshDevices();
      setDeviceFeedback({ text: message });
    } catch (error) {
      setDeviceFeedback(errorFeedback(error, "Couldn’t update the device. Try again."));
    } finally {
      setWorking(false);
    }
  }

  async function sendTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || !activeDevices.length) return;
    if (testDevice && !testTarget) {
      setTestDevice("");
      setSendFeedback({ text: "The chosen device is paused or removed. Choose a destination and try again.", error: true });
      return;
    }
    setWorking(true);
    setSendFeedback(null);
    try {
      const result = await api<{ message: string }>("/api/test", "POST", { title, body, deviceId: testTarget || undefined });
      setSendFeedback({ text: result.message });
    } catch (error) {
      setSendFeedback(errorFeedback(error, "Couldn’t send the test."));
    } finally {
      refreshDevices().catch(() => undefined);
      setWorking(false);
    }
  }

  return (
    <div className="workspace">
      <section className="card device-card" aria-labelledby="device-title">
        <div className="card-header">
          <h2 id="device-title">Your devices</h2>
          {state && <span className="state">{activeDevices.length} active</span>}
        </div>
        <p className="supporting">ChatGPT sends alerts to every active device. Paused devices stay paused until you resume them here.</p>
        {devices.length > 0 && (
          <ul className="devices">
            {devices.map((device) => (
              <li key={device.id} className="device-row">
                <div className="device-heading">
                  <div><strong>{device.name}</strong><time dateTime={new Date(device.enrolledAt).toISOString()}>
                    Enrolled {new Date(device.enrolledAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
                  </time></div>
                  <span className={device.paused ? "state paused" : "state enrolled"}>{device.paused ? "Paused" : "Active"}</span>
                </div>
                {rename?.id === device.id ? (
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    if (rename.name.trim()) void manage("PATCH", rename, "Device renamed.");
                  }}>
                    <label htmlFor="rename-device">Device name</label>
                    <input id="rename-device" value={rename.name} onChange={(event) => setRename({ id: device.id, name: event.target.value })}
                      required maxLength={60} autoFocus />
                    <div className="actions">
                      <button type="submit" disabled={working || !rename.name.trim()}>Save name</button>
                      <button className="secondary" type="button" onClick={() => setRename(null)} disabled={working}>Cancel</button>
                    </div>
                  </form>
                ) : removing === device.id ? (
                  <div className="remove-device">
                    <p>Remove this device? You can enroll it again from that device.</p>
                    <div className="actions">
                      <button className="secondary danger" type="button" onClick={() => manage("DELETE", { id: device.id }, `${device.name} removed.`)} disabled={working}>Remove device</button>
                      <button className="secondary" type="button" onClick={() => setRemoving(null)} disabled={working}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="actions">
                    <button className="secondary" type="button" disabled={working} aria-label={`${device.paused ? "Resume" : "Pause"} ${device.name}`}
                      onClick={() => manage("PATCH", { id: device.id, paused: !device.paused }, `${device.name} ${device.paused ? "resumed" : "paused"}.`)}>
                      {device.paused ? "Resume" : "Pause"}
                    </button>
                    <button className="secondary" type="button" disabled={working} aria-label={`Rename ${device.name}`}
                      onClick={() => { setRemoving(null); setRename({ id: device.id, name: device.name }); }}>Rename</button>
                    <button className="secondary danger" type="button" disabled={working} aria-label={`Remove ${device.name}`}
                      onClick={() => { setRename(null); setRemoving(device.id); }}>Remove</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {state && !devices.length && <p className="supporting">No devices are enrolled yet.</p>}
        {canEnroll ? (
          <form className="enroll-device" onSubmit={enable}>
            <label htmlFor="device-name">Name this device</label>
            <input id="device-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} placeholder="e.g. Pixel phone" />
            <button type="submit" disabled={working || !state?.publicKey || !name.trim()}>Enroll this device</button>
          </form>
        ) : canEnroll === false && <p className="supporting enrollment-note">To enroll, open this Site directly in a supported browser such as Chrome or Firefox.</p>}
        {state && !state.publicKey && <p className="feedback error" role="alert">Complete the Site’s notification configuration to enable enrollment.</p>}
        <p className={deviceFeedback?.error ? "feedback error" : "feedback"} role="status">{deviceFeedback?.text}</p>
      </section>
      <section className="card" aria-labelledby="test-title">
        <h2 id="test-title">Send a test</h2>
        <form onSubmit={sendTest}>
          <label htmlFor="test-device">Destination</label>
          <select id="test-device" value={testDevice} onChange={(event) => setTestDevice(event.target.value)} disabled={!activeDevices.length}>
            <option value="">All active devices</option>
            {testDevice && !testTarget && <option value={testDevice} disabled>Device unavailable</option>}
            {activeDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
          </select>
          <label htmlFor="alert-title">Title</label>
          <input id="alert-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} />
          <label htmlFor="alert-body">Message</label>
          <textarea id="alert-body" value={body} onChange={(event) => setBody(event.target.value)} required maxLength={700} rows={3} />
          <button type="submit" disabled={working || !activeDevices.length || !title.trim() || !body.trim()}>Send test</button>
        </form>
        <p className={sendFeedback?.error ? "feedback error" : "feedback"} role="status">
          {sendFeedback?.text ?? (!activeDevices.length && state ? "Enroll or resume a device to send a test." : "")}
        </p>
      </section>
    </div>
  );
}
