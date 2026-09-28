/** Chat: run the agent from the browser and watch it work.
 *
 * No conversation picker here: browsing history lives in the History view, and
 * this view only continues a session you arrived with (from History, or from a
 * previous run on this page). Keeping the two apart gives the thread the full
 * width and the composer room to breathe.
 */

import { api, streamRun, type RunEvent, type RunSnapshot } from "./api.js";
import { announce, clear, clockTime, h, icon } from "./dom.js";
import { emptyState, pageHeader } from "./view-kit.js";

interface Turn {
  role: "user" | "assistant" | "tool";
  text: string;
  at: number;
}

function turnEl(turn: Turn): HTMLElement {
  const wrap = h("div", { class: `msg msg-${turn.role}` });
  const head = h("div", { class: "msg-head" });
  head.appendChild(h("span", { text: turn.role === "tool" ? "tool" : turn.role }));
  head.appendChild(h("span", { text: clockTime(turn.at) }));
  wrap.appendChild(head);
  wrap.appendChild(h("div", { class: "msg-body", text: turn.text }));
  return wrap;
}

function eventsToLines(events: RunEvent[]): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = [];
  for (const ev of events) {
    const t = clockTime(ev.ts);
    switch (ev.kind) {
      case "status":
        out.push({ text: `${t}  ${ev.text ?? ""}`, cls: "meta" });
        break;
      case "session_id":
        out.push({ text: `${t}  session ${ev.session_id ?? ""}`, cls: "meta" });
        break;
      case "out":
        out.push({ text: `${t}  ${ev.text ?? ""}`, cls: "" });
        break;
      case "error":
        out.push({ text: `${t}  ERROR ${ev.text ?? ""}`, cls: "err" });
        break;
      case "exit":
        out.push({ text: `${t}  exit ${ev.code ?? "?"}`, cls: ev.code === 0 ? "meta" : "err" });
        break;
      default:
        break;
    }
  }
  return out;
}

export function renderChat(initialSession = ""): HTMLElement {
  const root = h("div");

  let session = initialSession;
  let activeRun: string | null = null;
  let disposeStream: (() => void) | null = null;
  let busy = false;

  const head = pageHeader(
    "Chat",
    "Runs `hermes chat` on this machine. Each message continues the same conversation, so the agent keeps its context.",
  );
  const sessionChip = h("span", { class: "chip" });
  const newBtn = h("button", { class: "btn", type: "button" }, icon("plus", 15), "New conversation");
  const headActions = h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" });
  headActions.appendChild(sessionChip);
  headActions.appendChild(newBtn);
  head.appendChild(headActions);
  root.appendChild(head);

  const panel = h("div", { class: "panel" });
  const thread = h("div", { class: "thread", id: "thread" });

  function threadEmpty(): HTMLElement {
    return emptyState(
      "Nothing in this conversation yet",
      "Type a message below. It runs on this device with the tools and skills already configured for Hermes.",
    );
  }

  function setSessionLabel(): void {
    sessionChip.textContent = session ? `session ${session}` : "new conversation";
    sessionChip.className = session ? "chip chip-accent" : "chip";
  }

  async function loadThread(): Promise<void> {
    if (!session) {
      clear(thread);
      thread.appendChild(threadEmpty());
      return;
    }
    clear(thread);
    thread.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const detail = await api.session(session);
      clear(thread);
      const turns: Turn[] = [];
      for (const m of detail.messages) {
        if (!m.content) continue;
        if (m.role === "user" || m.role === "assistant" || m.role === "tool") {
          turns.push({ role: m.role, text: m.content, at: m.timestamp });
        }
      }
      if (turns.length === 0) thread.appendChild(threadEmpty());
      else for (const turn of turns) thread.appendChild(turnEl(turn));
      thread.scrollTop = thread.scrollHeight;
    } catch (err) {
      clear(thread);
      thread.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          h("p", { text: `Could not read this conversation: ${String(err)}` }),
        ),
      );
    }
  }

  panel.appendChild(thread);

  // ---- live run -------------------------------------------------------
  const liveWrap = h("div", { style: "padding:0 16px 16px;display:none" });
  const liveHead = h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" });
  const liveDot = h("span", { class: "dot dot-idle" });
  const liveLabel = h("span", { class: "hint", text: "Idle" });
  const watchBtn = h("button", { class: "btn", type: "button" }, icon("activity", 14), "Watch in Work");
  const stopBtn = h("button", { class: "btn btn-danger", type: "button" }, icon("square", 14), "Stop");
  liveHead.appendChild(liveDot);
  liveHead.appendChild(liveLabel);
  liveHead.appendChild(h("span", { class: "spacer", style: "margin-left:auto" }));
  liveHead.appendChild(watchBtn);
  liveHead.appendChild(stopBtn);
  const liveBox = h("div", { class: "live", role: "log", "aria-live": "polite" });
  liveWrap.appendChild(liveHead);
  liveWrap.appendChild(liveBox);
  panel.appendChild(liveWrap);

  watchBtn.addEventListener("click", () => {
    window.location.hash = activeRun ? `#/work/${encodeURIComponent(activeRun)}` : "#/work";
  });

  function pushLive(lines: { text: string; cls: string }[]): void {
    for (const line of lines) liveBox.appendChild(h("span", { class: `live-line ${line.cls}`, text: line.text }));
    liveBox.scrollTop = liveBox.scrollHeight;
  }

  // ---- composer -------------------------------------------------------
  const composer = h("form", { class: "composer" });
  const input = h("textarea", {
    class: "textarea",
    id: "chat-input",
    placeholder: "Ask Hermes to do something on this device.",
    "aria-label": "Message to Hermes",
    rows: 3,
  });
  const actions = h("div", { class: "composer-actions" });
  const send = h("button", { class: "btn btn-primary", type: "submit" }, icon("send", 16), "Send");
  actions.appendChild(send);
  actions.appendChild(h("span", { class: "hint", text: "Ctrl+Enter sends." }));
  composer.appendChild(input);
  composer.appendChild(actions);

  function setBusy(value: boolean): void {
    busy = value;
    send.disabled = value;
    stopBtn.disabled = !value;
    liveDot.className = `dot ${value ? "dot-warn" : "dot-idle"}`;
    liveLabel.textContent = value ? "Running" : "Idle";
  }
  stopBtn.disabled = true;

  async function stop(): Promise<void> {
    if (!activeRun) return;
    try {
      await api.stopRun(activeRun);
      announce("Stopping the run.");
    } catch (err) {
      announce(`Could not stop the run: ${String(err)}`);
    }
  }
  stopBtn.addEventListener("click", () => void stop());

  function attachStream(runId: string): void {
    disposeStream?.();
    disposeStream = streamRun(runId, {
      onEvent: (ev) => {
        if (ev.kind === "session_id" && ev.session_id) {
          session = ev.session_id;
          setSessionLabel();
        }
        pushLive(eventsToLines([ev]));
      },
      onEnd: (final) => {
        setBusy(false);
        disposeStream = null;
        if (final.reply) {
          thread.appendChild(turnEl({ role: "assistant", text: final.reply, at: Date.now() / 1000 }));
        }
        if (final.status === "error" || final.error) {
          thread.appendChild(
            h(
              "div",
              { class: "state state-error", role: "alert", style: "margin:8px 0" },
              h("p", { text: final.error || `The run failed with exit code ${final.exit_code ?? "?"}.` }),
            ),
          );
        }
        announce(final.status === "done" ? "Run finished." : `Run ended: ${final.status}.`);
        thread.scrollTop = thread.scrollHeight;
      },
      onError: (message) => {
        setBusy(false);
        announce(message);
        pushLive([{ text: `  ${message}`, cls: "err" }]);
      },
    });
  }

  async function submit(): Promise<void> {
    const message = input.value.trim();
    if (!message || busy) return;
    input.value = "";
    liveWrap.style.display = "block";
    clear(liveBox);
    thread.appendChild(turnEl({ role: "user", text: message, at: Date.now() / 1000 }));
    thread.scrollTop = thread.scrollHeight;
    setBusy(true);

    try {
      const started = await api.chat(session, message);
      activeRun = started.run_id;
      announce("Run started.");
      attachStream(started.run_id);
    } catch (err) {
      setBusy(false);
      const message2 = err instanceof Error ? err.message : String(err);
      pushLive([{ text: `  ${message2}`, cls: "err" }]);
      thread.appendChild(
        h("div", { class: "state state-error", role: "alert", style: "margin:8px 0" }, h("p", { text: message2 })),
      );
      announce(message2);
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  });

  newBtn.addEventListener("click", () => {
    session = "";
    setSessionLabel();
    clear(thread);
    thread.appendChild(threadEmpty());
    input.focus();
    announce("Starting a new conversation.");
  });

  panel.appendChild(composer);
  root.appendChild(panel);

  // Restore a run still in flight when the page was (re)loaded, so a reload does
  // not silently orphan a job that is still costing tokens.
  void api
    .runs()
    .then((data) => {
      const running = data.runs.find((r: RunSnapshot) => r.status === "running");
      if (!running) return;
      activeRun = running.id;
      session = running.session_id ?? running.session;
      setSessionLabel();
      liveWrap.style.display = "block";
      setBusy(true);
      pushLive(eventsToLines(running.events));
      attachStream(running.id);
    })
    .catch(() => {
      /* nothing in flight is not an error worth showing */
    });

  setSessionLabel();
  void loadThread();
  queueMicrotask(() => input.focus());

  return root;
}
