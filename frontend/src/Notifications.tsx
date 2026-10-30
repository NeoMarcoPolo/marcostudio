import { useCallback, useEffect, useRef, useState } from "react";

export type Notice = {id: number; text: string; failure: boolean};

export function useNotifications() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const next = useRef(0);
  const announced = useRef(new Set<number>());
  const dismiss = useCallback((id: number) => setNotices(items => items.filter(item => item.id !== id)), []);
  const notify = useCallback((text: string, failure = false) => {
    const id = ++next.current;
    setNotices(items => {
      if (items.length < 25) return [...items, {id, text, failure}];
      console.warn("Notification queue full; additional events are summarized. See setup and task history for details.");
      return [...items.slice(0, 24), {id: -1, text: "Additional events occurred. Check setup and task history for details.", failure: true}];
    });
  }, [dismiss]);
  return {notices, dismiss, notify, announced};
}

export function Notifications({notices, dismiss, announced}: {notices: Notice[]; dismiss: (id: number) => void; announced: {current: Set<number>}}) {
  // The queue may move into or out of a native dialog. Existing visible
  // notices become the baseline on mount and are not announced again.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [polite, setPolite] = useState<{id: number; text: string}>();
  const [urgent, setUrgent] = useState<{id: number; text: string}>();
  useEffect(() => {
    const fresh = notices.filter(notice => !announced.current.has(notice.id));
    fresh.forEach(notice => announced.current.add(notice.id));
    if (fresh.some(notice => !notice.failure)) setPolite({id: fresh.at(-1)!.id, text: fresh.filter(notice => !notice.failure).map(notice => notice.text).join(" ")});
    if (fresh.some(notice => notice.failure)) setUrgent({id: fresh.at(-1)!.id, text: fresh.filter(notice => notice.failure).map(notice => notice.text).join(" ")});
  }, [notices, announced]);
  useEffect(() => {
    const visible = notices.slice(0, 3).filter(notice => !notice.failure);
    for (const [id, timer] of timers.current) if (!visible.some(notice => notice.id === id)) {clearTimeout(timer); timers.current.delete(id);}
    for (const notice of visible) if (!timers.current.has(notice.id)) {
      const timer = setTimeout(() => {timers.current.delete(notice.id); dismiss(notice.id);}, 8000);
      timers.current.set(notice.id, timer);
    }
  }, [notices, dismiss]);
  useEffect(() => () => {timers.current.forEach(clearTimeout); timers.current.clear();}, []);
  // Failures remain in the queue until dismissed; only three are displayed at
  // once, so a burst remains navigable without covering the workspace.
  return <div className="notifications" aria-label="Notifications">
    <div className="notification-announcer" role="status" aria-live="polite">{polite && <span key={polite.id}>{polite.text}</span>}</div>
    <div className="notification-announcer" aria-label="Urgent notifications" aria-live="assertive">{urgent && <span key={urgent.id}>{urgent.text}</span>}</div>
    {notices.slice(0, 3).map(notice => <div className={`notification${notice.failure ? " is-failure" : ""}`} key={notice.id}>
      <span>{notice.text}</span><button type="button" aria-label="Dismiss notification" onClick={() => dismiss(notice.id)}>×</button>
    </div>)}
    {notices.length > 3 && <p>{notices.length - 3} more notifications</p>}
  </div>;
}
