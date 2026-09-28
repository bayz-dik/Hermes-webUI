/** Overview: what this install is, right now. */

import { api, type SystemInfo, type ToolsResponse } from "./api.js";
import { bytes, h, icon, num, relTime } from "./dom.js";
import { createAsyncBox, pageHeader } from "./view-kit.js";

function stat(label: string, value: string, note: string): HTMLElement {
  const box = h("div", { class: "stat" });
  box.appendChild(h("span", { class: "stat-label", text: label }));
  box.appendChild(h("span", { class: "stat-value", text: value }));
  box.appendChild(h("span", { class: "stat-note", text: note }));
  return box;
}

function kv(pairs: [string, string][]): HTMLElement {
  const dl = h("dl", { class: "kv" });
  for (const [key, value] of pairs) {
    dl.appendChild(h("dt", { text: key }));
    dl.appendChild(h("dd", { text: value || "-" }));
  }
  return dl;
}

function toolChips(tools: ToolsResponse): HTMLElement {
  const wrap = h("div", { class: "cat-list" });
  const all = [...tools.builtin, ...tools.plugin];
  for (const tool of all) {
    wrap.appendChild(
      h(
        "span",
        { class: `chip ${tool.enabled ? "chip-ok" : ""}` },
        tool.enabled ? icon("check", 12) : icon("x", 12),
        tool.name,
      ),
    );
  }
  return wrap;
}

export function renderOverview(): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader("Overview", "State of this Hermes install: model, tools, storage, and what the console is talking to."),
  );

  const box = createAsyncBox();
  root.appendChild(box.el);

  void box.load(
    async () => {
      const [system, tools, sessions, plugins] = await Promise.all([
        api.system(),
        api.tools(),
        api.sessions({ limit: 200 }),
        api.plugins(),
      ]);
      return { system, tools, sessions, plugins };
    },
    ({ system, tools, sessions, plugins }) => {
      const nodes: Node[] = [];

      const stats = h("div", { class: "grid grid-4" });
      stats.appendChild(stat("Model", system.config.model ?? "-", system.config.provider ?? "unknown provider"));
      stats.appendChild(
        stat("Skills", String(system.skills_count), `${plugins.enabled} plugins enabled`),
      );
      stats.appendChild(stat("Sessions", String(sessions.total), `${num(sessions.sessions.reduce((n, s) => n + s.message_count, 0))} messages`));
      stats.appendChild(
        stat("Disk free", `${system.disk_free_gb} GB`, `of ${system.disk_total_gb} GB on this device`),
      );
      nodes.push(stats);

      const grid = h("div", { class: "grid grid-2", style: "margin-top:16px" });

      const about = h("div", { class: "panel panel-pad" });
      about.appendChild(h("h3", { style: "margin:0 0 12px;font-size:15px;font-weight:600", text: "Runtime" }));
      about.appendChild(
        kv([
          ["Hermes", system.version ? `${system.version} (${system.upstream})` : "unknown"],
          ["Install", system.install_dir],
          ["Home", system.hermes_home],
          ["Python", system.python],
          ["Platform", system.platform],
          ["Env keys", `${system.env_keys} set in .env`],
          ["Interface", system.config.interface ?? "cli"],
          ["Console uptime", `${system.uptime_s}s`],
        ]),
      );
      grid.appendChild(about);

      const toolPanel = h("div", { class: "panel panel-pad" });
      toolPanel.appendChild(
        h("h3", { style: "margin:0 0 12px;font-size:15px;font-weight:600", text: `Tools (${tools.enabled_count} of ${tools.total} on)` }),
      );
      if (tools.error) {
        toolPanel.appendChild(h("p", { class: "hint", text: tools.error }));
      }
      toolPanel.appendChild(toolChips(tools));
      grid.appendChild(toolPanel);

      nodes.push(grid);

      const recent = h("div", { style: "margin-top:16px" });
      recent.appendChild(h("h3", { style: "margin:0 0 12px;font-size:15px;font-weight:600", text: "Recent sessions" }));
      const panel = h("div", { class: "panel" });
      const rows = h("div", { class: "rows" });
      for (const s of sessions.sessions.slice(0, 6)) {
        const row = h("div", { class: "row row-static" });
        const main = h("div", { class: "row-main" });
        main.appendChild(h("div", { class: "row-title", text: s.title || s.display_name || s.id }));
        main.appendChild(
          h("div", {
            class: "row-sub",
            text: `${s.model ?? "unknown model"} · ${s.source ?? "cli"} · ${s.message_count} messages`,
          }),
        );
        row.appendChild(main);
        row.appendChild(h("div", { class: "row-meta", text: relTime(s.last_activity_at ?? s.started_at) }));
        rows.appendChild(row);
      }
      if (sessions.sessions.length === 0) {
        rows.appendChild(h("div", { class: "row row-static" }, h("div", { class: "row-main" }, h("div", { class: "row-sub", text: "No sessions recorded yet." }))));
      }
      panel.appendChild(rows);
      recent.appendChild(panel);
      nodes.push(recent);

      const foot = h("p", { class: "hint", style: "margin-top:16px" });
      foot.appendChild(icon("circle-alert", 13));
      foot.appendChild(
        document.createTextNode(
          ` Config file: ${system.config.path}. This console reads Hermes state and never edits it.`,
        ),
      );
      nodes.push(foot);

      return nodes;
    },
  );

  return root;
}

export function bytesNote(system: SystemInfo): string {
  return `${bytes(Math.round(system.disk_free_gb * 1024 ** 3))} free`;
}
