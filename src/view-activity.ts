/** Activity: the live agent-loop feed written by the live-activity plugin.
 *
 * When the plugin is off there is no feed, and the view says exactly that plus
 * how to turn it on, instead of showing an empty box.
 */

import { api, streamActivity, type ActivityEvent } from "./api.js";
import { clear, clockTime, h, icon } from "./dom.js";
import { createAsyncBox, pageHeader } from "./view-kit.js";

const TYPE_LABEL: Record<string, string> = {
  session_start: "session",
  session_end: "end",
  turn_start: "turn",
  turn_end: "turn end",
  api_start: "api",
  api_end: "api end",
  tool_start: "tool",
  tool_end: "tool end",
  error: "error",
};

function detailFor(ev: ActivityEvent): string {
  switch (ev.type) {
    case "tool_start":
      return `${ev.tool ?? "?"} ${ev.brief ? `· ${ev.brief}` : ""}`.trim();
    case "tool_end":
      return `${ev.tool ?? "?"} · ${ev.dur !== undefined ? `${ev.dur.toFixed(2)}s` : ""} ${ev.chars !== undefined ? `${ev.chars} chars` : ""}`.trim();
    case "api_start":
      return `${ev.model ?? ""} · call ${String(ev.call ?? "")} · ${String(ev.in_tokens ?? "")} in`;
    case "api_end":
      return `${ev.model ?? ""} · ${JSON.stringify(ev.usage ?? {})}`;
    case "turn_start":
      return ev.prompt ? String(ev.prompt).slice(0, 140) : "";
    case "turn_end":
      return ev.reply_chars !== undefined ? `${ev.reply_chars} chars back` : "";
    case "error":
      return String(ev.reason ?? "");
    case "session_start":
      return `${ev.model ?? ""} · ${ev.platform ?? ""}`.trim();
    default:
      return "";
  }
}

export function renderActivity(): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Activity",
      "Structured events from the agent loop on this machine, streamed live from the live-activity plugin.",
    ),
  );

  const bar = h("div", { class: "toolbar" });
  const status = h("span", { class: "status-line" });
  const dot = h("span", { class: "dot dot-idle" });
  const statusText = h("span", { text: "connecting" });
  status.appendChild(dot);
  status.appendChild(statusText);
  const pause = h("button", { class: "btn", type: "button" }, icon("square", 14), "Pause");
  const clearBtn = h("button", { class: "btn", type: "button" }, icon("trash-2", 14), "Clear view");
  bar.appendChild(status);
  bar.appendChild(h("span", { class: "spacer", style: "margin-left:auto" }));
  bar.appendChild(pause);
  bar.appendChild(clearBtn);
  root.appendChild(bar);

  const panel = h("div", { class: "panel" });
  const feed = h("div", { class: "feed", role: "log", "aria-live": "polite" });
  panel.appendChild(feed);
  root.appendChild(panel);

  let paused = false;
  let dispose: (() => void) | null = null;
  let since = Date.now() / 1000 - 300;
  let count = 0;
  let reconnectTimer: number | undefined;

  const countLine = h("p", { class: "hint", style: "margin:12px 0 0" });
  root.appendChild(countLine);

  function setStatus(text: string, kind: "ok" | "err" | "idle"): void {
    statusText.textContent = text;
    dot.className = `dot dot-${kind}`;
  }

  function addRow(ev: ActivityEvent): void {
    count += 1;
    const row = h("div", { class: "feed-row" });
    row.appendChild(h("span", { class: "feed-time", text: clockTime(ev.ts) }));
    row.appendChild(h("span", { class: "feed-type", text: TYPE_LABEL[ev.type] ?? ev.type }));
    row.appendChild(h("span", { class: "feed-detail", text: detailFor(ev) || " " }));
    row.appendChild(h("span", { class: "row-meta", text: ev.session ? ev.session.slice(-6) : "" }));
    if (ev.type === "error") row.style.color = "var(--err)";
    feed.appendChild(row);
    while (feed.childElementCount > 400) {
      const first = feed.firstElementChild;
      if (first) feed.removeChild(first);
      else break;
    }
    feed.scrollTop = feed.scrollHeight;
    countLine.textContent = `${count} events shown${paused ? " (paused)" : ""}. Showing the last 5 minutes plus everything since this page opened.`;
  }

  function connect(): void {
    dispose?.();
    setStatus("connecting", "idle");
    dispose = streamActivity(since, {
      onEvent: (ev) => {
        since = Math.max(since, ev.ts);
        if (!paused) addRow(ev);
      },
      onState: (state) => {
        if (state === "open") {
          setStatus(paused ? "paused" : "live", paused ? "idle" : "ok");
          return;
        }
        setStatus("reconnecting", "err");
        // The server may have restarted; re-subscribe with a fresh window
        // instead of leaving the view silently dead.
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          since = Date.now() / 1000 - 60;
          connect();
        }, 3000);
      },
    });
  }

  pause.addEventListener("click", () => {
    paused = !paused;
    pause.replaceChildren(
      paused ? icon("activity", 14) : icon("square", 14),
      document.createTextNode(paused ? "Resume" : "Pause"),
    );
    setStatus(paused ? "paused" : "live", paused ? "idle" : "ok");
    countLine.textContent = `${count} events shown${paused ? " (paused)" : ""}.`;
  });
  clearBtn.addEventListener("click", () => {
    clear(feed);
    count = 0;
    countLine.textContent = "0 events shown.";
  });

  window.addEventListener("beforeunload", () => {
    window.clearTimeout(reconnectTimer);
    dispose?.();
  });
  connect();

  const box = createAsyncBox();
  root.appendChild(box.el);
  void box.load(
    () => api.activity(0),
    (data) => {
      // Seed the view with what already happened, then let the stream continue.
      const events = data.events.slice(-120);
      for (const ev of events) addRow(ev);
      if (events.length === 0) {
        const note = h("div", { class: "panel panel-pad", style: "margin-bottom:12px" });
        note.appendChild(h("h3", { style: "margin:0 0 8px;font-size:15px;font-weight:600", text: "No events yet" }));
        note.appendChild(
          h("p", {
            class: "hint",
            style: "margin:0",
            text: "The feed is empty. Events appear when an agent session runs. If nothing shows up during a run, enable the plugin with: hermes plugins enable live-activity",
          }),
        );
        return [note];
      }
      return [];
    },
  );

  return root;
}
