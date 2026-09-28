/** Cron: scheduled jobs, with the reason each field is empty when it is. */

import { api, type CronJob } from "./api.js";
import { h, icon, relTime } from "./dom.js";
import { createAsyncBox, emptyState, pageHeader } from "./view-kit.js";

function scheduleText(job: CronJob): string {
  const s = job.schedule;
  if (typeof s === "string") return s;
  if (s && typeof s === "object") {
    const rec = s as Record<string, unknown>;
    if (typeof rec.expr === "string") return rec.expr;
    if (typeof rec.kind === "string") {
      return rec.every ? `${rec.kind} · ${String(rec.every)}` : rec.kind;
    }
    return JSON.stringify(s);
  }
  return "not set";
}

export function renderCron(): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Cron",
      "Scheduled jobs stored for this Hermes. Jobs fire while the scheduler is running; create and edit them from a terminal with `hermes cron`.",
    ),
  );

  const box = createAsyncBox();
  root.appendChild(box.el);

  void box.load(
    () => api.cron(),
    (data) => {
      if (data.total === 0) {
        return [
          emptyState(
            "No scheduled jobs",
            "Nothing is queued. Create one from a terminal with `hermes cron create '30m' \"your prompt\"`, then reload this page.",
          ),
        ];
      }
      const nodes: Node[] = [];
      const list = h("div", { class: "panel" });
      const rows = h("div", { class: "rows" });
      for (const job of data.jobs) {
        const row = h("div", { class: "row row-static", style: "align-items:flex-start;padding-top:14px;padding-bottom:14px" });
        const main = h("div", { class: "row-main" });
        const titleLine = h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" });
        titleLine.appendChild(h("span", { class: "row-title", text: job.name ?? job.id ?? "unnamed job" }));
        const off = job.paused === true || job.enabled === false;
        titleLine.appendChild(
          off
            ? h("span", { class: "chip chip-warn" }, icon("square", 12), "paused")
            : h("span", { class: "chip chip-ok" }, icon("check", 12), "active"),
        );
        titleLine.appendChild(h("span", { class: "chip", text: scheduleText(job) }));
        if (job.deliver) titleLine.appendChild(h("span", { class: "chip", text: `-> ${job.deliver}` }));
        main.appendChild(titleLine);
        if (job.prompt) {
          main.appendChild(
            h("div", {
              class: "row-sub",
              style: "white-space:normal;margin-top:6px;line-height:1.5",
              text: job.prompt,
            }),
          );
        }
        const meta = h("div", { class: "row-sub", style: "margin-top:6px" });
        meta.textContent = [
          job.next_run_at ? `next ${relTime(job.next_run_at)}` : "",
          job.last_run_at ? `last ${relTime(job.last_run_at)}` : "never run",
          job.run_count !== undefined ? `${job.run_count} runs` : "",
          job.repeat !== undefined && job.repeat !== null ? `repeat ${job.repeat}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        main.appendChild(meta);
        row.appendChild(main);
        rows.appendChild(row);
      }
      list.appendChild(rows);
      nodes.push(list);

      const note = h("p", { class: "hint", style: "margin-top:12px" });
      note.appendChild(icon("circle-alert", 13));
      note.appendChild(
        document.createTextNode(
          " Jobs scheduled from a terminal run on this device only. If the scheduler is not running, nothing fires; check with `hermes cron status`.",
        ),
      );
      nodes.push(note);
      return nodes;
    },
  );

  return root;
}
