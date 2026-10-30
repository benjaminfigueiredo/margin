// Notifications for what happens while the author looks elsewhere: Claude finished its turn, needs
// the author, or answered an ask (`claude-event` from the server, see server/claude-events.js), and
// Overleaf has new commits (`git-changed`).
//
// In the Mac app the page hands each one to the app, which shows a macOS notification only when
// this paper's window is not in front (mac/Sources/Margin/Notifier.swift). The page talks to the app
// through window.webkit.messageHandlers.margin.postMessage(message), with these messages:
//   { type: 'notify', title, body, tag }      a notification; a later one with the same tag replaces it
//   { type: 'splitWithClaude', paper? }       put the paper's window above Terminal running claude
//                                             (paper: a hub paper id, from the Papers page)
// In a browser it uses the Web Notifications API, only after the author turned it on (Aa →
// Notifications; the browser asks for permission then, never on load), and only when the page is
// hidden or not focused.
import { $, toast } from './util.js';

const KEY = 'margin:notify';
const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const write = (on) => { try { localStorage.setItem(KEY, on ? '1' : ''); } catch { /* this page only */ } };

// The Mac app's message handler, or null in a browser.
export function appHost() {
  try { return window.webkit?.messageHandlers?.margin || null; } catch { return null; }
}
export function postToApp(message) {
  const host = appHost();
  if (!host) return false;
  try { host.postMessage(message); return true; } catch { return false; }
}

export function initNotify({ getName }) {
  const box = $('#set-notify'), label = $('#notify-label'), hint = $('#notify-hint');
  const inApp = !!appHost();
  const supported = typeof window.Notification === 'function';
  let lastBehind = 0;

  if (inApp) {
    label.remove(); // (.check's display wins over .hidden)
    hint.textContent = 'Margin notifies you when Claude is done or needs you and this window is not in front. Turn it off in System Settings → Notifications → Margin.';
  } else if (!supported) {
    box.disabled = true;
    hint.textContent = 'This browser cannot show notifications.';
  } else {
    box.checked = read() && Notification.permission === 'granted';
    box.addEventListener('change', async () => {
      if (!box.checked) { write(false); return; }
      let permission = Notification.permission;
      if (permission === 'default') { try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; } }
      if (permission !== 'granted') {
        box.checked = false;
        write(false);
        hint.textContent = 'The browser blocks notifications for this page. Allow them in its site settings, then turn this on again.';
        return;
      }
      write(true);
    });
  }

  // Returns what happened, for the tests: 'app', 'shown', or why nothing was shown.
  function notify({ title, body = '', tag }) {
    const full = `${title} — ${getName()}`;
    if (postToApp({ type: 'notify', title: full, body, tag })) return 'app';
    if (!supported || !read()) return 'off';
    if (document.visibilityState === 'visible' && document.hasFocus()) return 'visible';
    if (Notification.permission !== 'granted') return 'blocked';
    try {
      const n = new Notification(full, { body, tag: `${location.port}-${tag}` });
      n.onclick = () => { window.focus(); n.close(); };
      return 'shown';
    } catch { return 'failed'; }
  }

  return {
    notify,
    claudeEvent(msg) {
      if (!msg?.title) return;
      if (document.visibilityState === 'visible') toast(msg.body ? `${msg.title}: ${msg.body}` : msg.title, 'claude', 5000);
      notify({ title: msg.title, body: msg.body || '', tag: 'claude' });
    },
    gitChanged(msg) {
      const n = Number(msg?.behind) || 0;
      if (n > lastBehind) {
        const files = (msg.files || []).slice(0, 3).join(', ');
        notify({ title: `Overleaf has ${n} new commit${n === 1 ? '' : 's'}`, body: files ? `Changed: ${files}${msg.files.length > 3 ? ', …' : ''}. Pull before you keep editing.` : 'Pull before you keep editing.', tag: 'overleaf' });
      }
      lastBehind = n;
    },
  };
}
