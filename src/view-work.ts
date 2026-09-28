/** Work: what Hermes is doing right now, while it does it.
 *
 * The Chat view shows the answer. This shows the labour: which tool is running,
 * on what, for how long, and how the run is progressing. It reads the run's own
 * event stream, so it is live rather than a log you refresh.
 *
 * Two feeds are merged here on purpose:
 *  - the run's stdout lines (this process knows exactly when it started and ended)
 *  - the agent-loop activity feed from the live-activity plugin, which is the only
 *    source that names the tool and the argument it was called with.
 */

import { api, streamActivity, streamRun, type ActivityEvent, type RunEvent, type RunSnapshot } from "./api.js";
import { announce, bytes, clear, clockTime, h, icon, num } from "./dom.js";
import { createAsyncBox, emptyState, pageHeader } from "./view-kit.js";

type Phase = "idle" | "thinking" | "working" | "done" | "error";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  done: "Finished",
  error: "Failed",
};

/** A tool call, as the activity feed describes it. */
interface ToolStep {
  tool: string;
  brief: string;
  startedAt: number;
  endedAt: number | null;
  duration: number | null;
  chars: number | null;
  session: string;
}

function detailFor(ev: ActivityEvent): string {
  switch (ev.type) {
    case "tool_start":
      return `${ev.tool ?? "?"} ${ev.brief ?? ""}`.trim();
    case "tool_end":
      return `${ev.tool ?? "?"}${ev.dur !== undefined ? ` in ${ev.dur.toFixed(2)}s` : ""}${ev.chars !== undefined ? `, ${ev.chars} chars` : ""}`;
    case "api_start":
      return `${ev.model ?? ""} call ${String(ev.call ?? "")}`;
    case "turn_start":
      return ev.prompt ? String(ev.prompt).slice(0, 160) : "";
    case "turn_end":
      return ev.reply_chars !== undefined ? `${ev.reply_chars} chars returned` : "";
    case "error":
      return String(ev.reason ?? "error");
    case "session_start":
      return `${ev.model ?? ""} ${ev.platform ?? ""}`.trim();
    case "session_end":
      return ev.completed === true ? "completed" : "ended early";
    default:
      return "";
  }
}

/** Tool names that change files, versus ones that only look. */
const WRITE_TOOLS = new Set(["write_file", "patch", "skill_manage", "memory", "cronjob_manage"]);
const READ_TOOLS = new Set(["read_file", "search_files", "skill_view", "skills_list", "web_search", "web_extract"]);

function toolKind(tool: string): { label: string; cls: string } {
  if (WRITE_TOOLS.has(tool)) return { label: "writes", cls: "chip-warn" };
  if (READ_TOOLS.has(tool)) return { label: "reads", cls: "chip" };
  if (tool === "terminal" || tool === "execute_code") return { label: "runs", cls: "chip-accent" };
  if (tool === "browser_exec") return { label: "browses", cls: "chip-accent" };
  if (tool === "delegate_task") return { label: "delegates", cls: "chip-accent" };
  return { label: "calls", cls: "chip" };
}

export function renderWork(initialRunId = ""): HTMLElement {
  const root = h("div");

  let runId = initialRunId;
  let disposeRun: (() => void) | null = null;
  let disposeActivity: (() => void) | null = null;
  let phase: Phase = "idle";
  let steps: ToolStep[] = [];
  let activeTool: string | null = null;
  let eventCount = 0;
  let apiCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let runStart = 0;
  let runEnd: number | null = null;
  let startedSession = "";
  let tick: number | undefined;

  const head = pageHeader(
    "Work",
    "Live view of what the agent is doing: the tool it is running, on what, and for how long.",
  );
  root.appendChild(head);

  // ---- control bar ----------------------------------------------------
  const bar = h("div", { class: "toolbar" });
  const phaseDot = h("span", { class: "dot dot-idle" });
  const phaseText = h("span", { class: "row-title", text: "Idle" });
  const phaseLine = h("div", { class: "status-line" }, phaseDot, phaseText);
  const elapsed = h("span", { class: "chip", text: "0.0s" });
  const runChip = h("span", { class: "chip", text: "no run" });
  const follow = h("button", { class: "btn", type: "button" }, icon("check", 14), "Following latest");
  const stopBtn = h("button", { class: "btn btn-danger", type: "button" }, icon("square", 14), "Stop");
  bar.appendChild(phaseLine);
  bar.appendChild(elapsed);
  bar.appendChild(runChip);
  bar.appendChild(h("span", { class: "spacer", style: "margin-left:auto" }));
  bar.appendChild(follow);
  bar.appendChild(stopBtn);
  root.appendChild(bar);
  stopBtn.disabled = true;

  // ---- now / counters -------------------------------------------------
  const stats = h("div", { class: "grid grid-4", style: "margin-bottom:16px" });
  const nowBox = h("div", { class: "stat", style: "grid-column:span 2" });
  nowBox.appendChild(h("span", { class: "stat-label", text: "Right now" }));
  const nowValue = h("span", { class: "stat-value", style: "font-size:18px", text: "waiting" });
  const nowNote = h("span", { class: "stat-note", text: "No tool is running." });
  nowBox.appendChild(nowValue);
  nowBox.appendChild(nowNote);

  const callsBox = h("div", { class: "stat" });
  callsBox.appendChild(h("span", { class: "stat-label", text: "Tool calls" }));
  const callsValue = h("span", { class: "stat-value", text: "0" });
  const callsNote = h("span", { class: "stat-note", text: "0 files touched" });
  callsBox.appendChild(callsValue);
  callsBox.appendChild(callsNote);

  const tokBox = h("div", { class: "stat" });
  tokBox.appendChild(h("span", { class: "stat-label", text: "Tokens" }));
  const tokValue = h("span", { class: "stat-value", text: "0" });
  const tokNote = h("span", { class: "stat-note", text: "0 in / 0 out" });
  tokBox.appendChild(tokValue);
  tokBox.appendChild(tokNote);

  stats.appendChild(nowBox);
  stats.appendChild(callsBox);
  stats.appendChild(tokBox);
  root.appendChild(stats);

  // ---- step list ------------------------------------------------------
  const stepPanel = h("div", { class: "panel", style: "margin-bottom:16px" });
  const stepHead = h("div", { class: "panel-pad", style: "display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line)" });
  stepHead.appendChild(h("h3", { style: "margin:0;font-size:15px;font-weight:600", text: "Steps" }));
  const stepCount = h("span", { class: "chip", text: "0" });
  stepHead.appendChild(stepCount);
  stepPanel.appendChild(stepHead);
  const stepRows = h("div", { class: "rows", style: "max-height:420px;overflow-y:auto" });
  stepPanel.appendChild(stepRows);
  root.appendChild(stepPanel);

  // ---- raw feed -------------------------------------------------------
  const feedPanel = h("div", { class: "panel" });
  const feedHead = h("div", { class: "panel-pad", style: "display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line)" });
  feedHead.appendChild(h("h3", { style: "margin:0;font-size:15px;font-weight:600", text: "Event stream" }));
  const feedStatus = h("span", { class: "hint", text: "connecting" });
  feedHead.appendChild(feedStatus);
  feedPanel.appendChild(feedHead);
  const feed = h("div", { class: "feed", role: "log", "aria-live": "polite" });
  feedPanel.appendChild(feed);
  root.appendChild(feedPanel);

  const box = createAsyncBox();
  root.appendChild(box.el);

  // ---- rendering ------------------------------------------------------
  function setPhase(next: Phase): void {
    phase = next;
    phaseText.textContent = PHASE_LABEL[next];
    phaseDot.className = `dot dot-${next === "working" ? "dot-warn" : next === "error" ? "dot-err" : next === "done" ? "dot-ok" : "dot-idle"}`;
  }

  function paintSteps(): void {
    stepCount.textContent = String(steps.length);
    clear(stepRows);
    if (steps.length === 0) {
      stepRows.appendChild(
        h(
          "div",
          { class: "row row-static" },
          h("div", { class: "row-main" }, h("div", { class: "row-sub", text: "No tool has run yet." })),
        ),
      );
      return;
    }
    // Newest first: during a long run the thing you care about is at the top.
    for (const step of [...steps].reverse()) {
      const kind = toolKind(step.tool);
      const row = h("div", { class: "row row-static", style: "align-items:flex-start;padding-top:12px;padding-bottom:12px" });
      const main = h("div", { class: "row-main" });
      const titleLine = h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" });
      titleLine.appendChild(h("span", { class: "chip " + kind.cls, text: kind.label }));
      titleLine.appendChild(h("span", { class: "row-title", text: step.tool }));
      if (step.endedAt === null) {
        const spin = icon("loader-circle", 13);
        spin.classList.add("spin");
        titleLine.appendChild(spin);
      }
      main.appendChild(titleLine);
      if (step.brief) {
        main.appendChild(
          h("div", {
            class: "row-sub",
            style: "white-space:normal;margin-top:5px;font-family:var(--font-mono);font-size:12px;line-height:1.5",
            text: step.brief,
          }),
        );
      }
      row.appendChild(main);
      const meta = h("div", { class: "row-meta" });
      meta.textContent = step.endedAt === null
        ? "running"
        : `${(step.duration ?? 0).toFixed(2)}s${step.chars ? ` · ${bytes(step.chars)}` : ""}`;
      row.appendChild(meta);
      stepRows.appendChild(row);
    }
  }

  function paintCounters(): void {
    const writes = steps.filter((s) => WRITE_TOOLS.has(s.tool)).length;
    callsValue.textContent = String(steps.length);
    callsNote.textContent = `${writes} write${writes === 1 ? "" : "s"} · ${steps.filter((s) => s.endedAt === null).length} running`;
    tokValue.textContent = num(tokensIn + tokensOut);
    tokNote.textContent = `${num(tokensIn)} in / ${num(tokensOut)} out`;
  }

  function paintNow(): void {
    if (activeTool) {
      const step = steps.find((s) => s.tool === activeTool && s.endedAt === null);
      nowValue.textContent = activeTool;
      nowNote.textContent = step?.brief ? step.brief.slice(0, 120) : "running";
    } else if (phase === "done") {
      nowValue.textContent = "finished";
      nowNote.textContent = `${steps.length} tool calls completed.`;
    } else if (phase === "error") {
      nowValue.textContent = "failed";
      nowNote.textContent = "See the event stream for the reason.";
    } else if (phase === "idle" && steps.length === 0) {
      nowValue.textContent = "waiting";
      nowNote.textContent = runId ? "This run has not called a tool yet." : "No run selected.";
    } else {
      nowValue.textContent = phase === "thinking" ? "thinking" : "waiting";
      nowNote.textContent = "No tool is running.";
    }
  }

  function pushFeed(ev: ActivityEvent): void {
    eventCount += 1;
    const row = h("div", { class: "feed-row" });
    row.appendChild(h("span", { class: "feed-time", text: clockTime(ev.ts) }));
    row.appendChild(h("span", { class: "feed-type", text: ev.type }));
    row.appendChild(h("span", { class: "feed-detail", text: detailFor(ev) || " " }));
    row.appendChild(h("span", { class: "row-meta", text: ev.session ? ev.session.slice(-6) : "" }));
    if (ev.type === "error") row.style.color = "var(--err)";
    feed.appendChild(row);
    while (feed.childElementCount > 500) {
      const first = feed.firstElementChild;
      if (first) feed.removeChild(first);
      else break;
    }
    feed.scrollTop = feed.scrollHeight;
  }

  function pushRunLine(ev: RunEvent): void {
    const t = clockTime(ev.ts);
    const row = h("div", { class: "feed-row" });
    row.appendChild(h("span", { class: "feed-time", text: t }));
    row.appendChild(h("span", { class: "feed-type", text: `run:${ev.kind}` }));
    row.appendChild(
      h("span", {
        class: "feed-detail",
        text: ev.kind === "exit" ? `exit ${ev.code ?? "?"}` : (ev.text ?? ev.session_id ?? ""),
      }),
    );
    row.appendChild(h("span", { class: "row-meta", text: "" }));
    if (ev.kind === "error" || (ev.kind === "exit" && ev.code !== 0)) row.style.color = "var(--err)";
    feed.appendChild(row);
    feed.scrollTop = feed.scrollHeight;
  }

  function startClock(): void {
    window.clearInterval(tick);
    tick = window.setInterval(() => {
      if (!runStart) return;
      const end = runEnd ?? Date.now() / 1000;
      elapsed.textContent = `${(end - runStart).toFixed(1)}s`;
    }, 200);
  }

  // ---- activity subscription -----------------------------------------
  function subscribeActivity(): void {
    disposeActivity?.();
    disposeActivity = streamActivity(Date.now() / 1000 - 120, {
      onEvent: (ev) => {
        // Only this session's events, otherwise a concurrent run's steps would
        // be attributed to the one on screen.
        if (startedSession && ev.session && ev.session !== startedSession) return;
        feedStatus.textContent = "live";
        if (ev.type === "tool_start") {
          const step: ToolStep = {
            tool: String(ev.tool ?? "unknown"),
            brief: String(ev.brief ?? ""),
            startedAt: ev.ts,
            endedAt: null,
            duration: null,
            chars: null,
            session: String(ev.session ?? ""),
          };
          steps.push(step);
          activeTool = step.tool;
          setPhase("working");
        } else if (ev.type === "tool_end") {
          const open = [...steps].reverse().find((s) => s.endedAt === null && s.tool === ev.tool);
          if (open) {
            open.endedAt = ev.ts;
            open.duration = typeof ev.dur === "number" ? ev.dur : ev.ts - open.startedAt;
            open.chars = typeof ev.chars === "number" ? ev.chars : null;
          }
          activeTool = null;
          if (phase !== "done" && phase !== "error") setPhase("thinking");
        } else if (ev.type === "api_start") {
          apiCalls += 1;
          if (phase === "idle") setPhase("thinking");
        } else if (ev.type === "api_end") {
          const usage = ev.usage as { in?: number; out?: number } | undefined;
          if (usage) {
            tokensIn += Number(usage.in ?? 0);
            tokensOut += Number(usage.out ?? 0);
          }
        } else if (ev.type === "error") {
          setPhase("error");
        } else if (ev.type === "session_end") {
          if (phase !== "error") setPhase("done");
          runEnd = ev.ts;
        }
        pushFeed(ev);
        paintSteps();
        paintCounters();
        paintNow();
      },
      onState: (state) => {
        feedStatus.textContent = state === "open" ? "live" : "reconnecting";
      },
    });
  }

  // ---- run subscription ----------------------------------------------
  function subscribeRun(id: string): void {
    disposeRun?.();
    runId = id;
    runChip.textContent = `run ${id.slice(-6)}`;
    setPhase("thinking");
    runStart = Date.now() / 1000;
    startClock();
    stopBtn.disabled = false;

    disposeRun = streamRun(id, {
      onEvent: (ev) => {
        if (ev.kind === "session_id" && ev.session_id) {
          startedSession = ev.session_id;
        }
        if (ev.kind === "out" && phase === "thinking") setPhase("working");
        pushRunLine(ev);
      },
      onEnd: (final) => {
        runEnd = Date.now() / 1000;
        stopBtn.disabled = true;
        setPhase(final.status === "error" ? "error" : "done");
        paintNow();
        announce(final.status === "done" ? "Run finished." : `Run ended: ${final.status}.`);
        disposeRun = null;
      },
      onError: (message) => {
        feedStatus.textContent = message;
        stopBtn.disabled = true;
        setPhase("error");
        disposeRun = null;
      },
    });
  }

  function stopRun(): void {
    if (!runId) return;
    void api.stopRun(runId).then(
      () => announce("Stopping the run."),
      (err: unknown) => announce(`Could not stop: ${String(err)}`),
    );
  }
  stopBtn.addEventListener("click", stopRun);

  // ---- pick a run -----------------------------------------------------
  follow.addEventListener("click", () => {
    window.location.hash = "#/work";
    void pickLatest();
  });

  async function pickLatest(): Promise<void> {
    clear(box.el);
    box.el.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const data = await api.runs();
      clear(box.el);
      const running = data.runs.find((r: RunSnapshot) => r.status === "running");
      const latest = running ?? data.runs[0];
      if (!latest) {
        box.el.appendChild(
          emptyState(
            "No run to watch",
            "Start one in Chat. While it runs, this view shows each tool call as it happens.",
            { label: "Go to Chat", onClick: () => { window.location.hash = "#/chat"; } },
          ),
        );
        return;
      }
      if (latest.status !== "running") {
        const note = h("div", { class: "panel panel-pad", style: "margin-bottom:12px" });
        note.appendChild(h("h3", { style: "margin:0 0 8px;font-size:15px;font-weight:600", text: "Most recent run has already finished" }));
        note.appendChild(
          h("p", {
            class: "hint",
            style: "margin:0",
            text: `Run ${latest.id.slice(-6)} ended as "${latest.status}". The steps below are its record. Start a new run in Chat to watch one live.`,
          }),
        );
        box.el.appendChild(note);
      }
      startedSession = latest.session_id ?? latest.session;
      subscribeRun(latest.id);
    } catch (err) {
      clear(box.el);
      const message = err instanceof Error ? err.message : String(err);
      box.el.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          icon("triangle-alert", 28),
          h("h3", { text: "Could not list runs" }),
          h("p", { text: message }),
          h("button", { class: "btn", type: "button", onclick: () => void pickLatest() }, "Try again"),
        ),
      );
    }
  }

  // ---- boot -----------------------------------------------------------
  paintSteps();
  paintCounters();
  paintNow();
  subscribeActivity();

  if (runId) {
    // Arrived from Chat with a specific run: load its history, then follow it.
    void api.run(runId).then(
      (snapshot) => {
        startedSession = snapshot.session_id ?? snapshot.session;
        for (const ev of snapshot.events) pushRunLine(ev);
        if (snapshot.status === "running") {
          subscribeRun(snapshot.id);
        } else {
          runChip.textContent = `run ${snapshot.id.slice(-6)}`;
          setPhase(snapshot.status === "error" ? "error" : "done");
          runStart = snapshot.started_at;
          runEnd = snapshot.ended_at ?? null;
          paintNow();
        }
      },
      () => {
        box.el.appendChild(
          h("div", { class: "state state-error", role: "alert" }, h("p", { text: `Run ${runId} is not known to the server.` })),
        );
        void pickLatest();
      },
    );
  } else {
    void pickLatest();
  }

  window.addEventListener("beforeunload", () => {
    window.clearInterval(tick);
    disposeRun?.();
    disposeActivity?.();
  });

  return root;
}
