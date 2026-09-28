/** Settings: what the console reads, and the limits it has.
 *
 * Deliberately read-only. The console runs the agent, so it stays loopback-bound
 * and never rewrites Hermes config from a browser tab.
 */

import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { createAsyncBox, pageHeader } from "./view-kit.js";

export function renderSettings(): HTMLElement {
  const root = h("div");
  root.appendChild(pageHeader("Settings", "Connection details for this console, and the boundaries it holds to."));

  const box = createAsyncBox();
  root.appendChild(box.el);

  void box.load(
    () => api.system(),
    (system) => {
      const nodes: Node[] = [];

      const panel = h("div", { class: "panel panel-pad" });
      panel.appendChild(h("h3", { style: "margin:0 0 12px;font-size:15px;font-weight:600", text: "Hermes runtime" }));
      const dl = h("dl", { class: "kv" });
      const pairs: [string, string][] = [
        ["Version", system.version ? `${system.version} (${system.upstream})` : "unknown"],
        ["Model", system.config.model ?? "-"],
        ["Provider", system.config.provider ?? "-"],
        ["Base URL", system.config.base_url ?? "-"],
        ["Interface", system.config.interface ?? "cli"],
        ["Hermes home", system.hermes_home],
        ["Config file", system.config.path],
        ["Install dir", system.install_dir],
        ["Plugins on", system.config.plugins_enabled.join(", ") || "none"],
        ["Skills", `${system.skills_count} SKILL.md files`],
        ["Env keys", `${system.env_keys} entries in .env`],
        ["Disk", `${system.disk_free_gb} GB free of ${system.disk_total_gb} GB`],
        ["Console uptime", `${system.uptime_s}s`],
      ];
      for (const [k, v] of pairs) {
        dl.appendChild(h("dt", { text: k }));
        dl.appendChild(h("dd", { text: v }));
      }
      panel.appendChild(dl);
      nodes.push(panel);

      const limits = h("div", { class: "panel panel-pad", style: "margin-top:16px" });
      limits.appendChild(h("h3", { style: "margin:0 0 12px;font-size:15px;font-weight:600", text: "How this console is bounded" }));
      const ul = h("ul", { style: "margin:0;padding-left:20px;font-size:13px;line-height:1.7;color:var(--muted)" });
      const items = [
        "It binds 127.0.0.1 only, so nothing on your network can reach it.",
        "Every API call needs a token minted at startup and injected into the page. A page on another site cannot read it, which is what stops a cross-site call to this port.",
        "It opens the Hermes session database read-only. Nothing here can rewrite your sessions, skills, plugins, or config.",
        "Chat runs `hermes chat` on this machine with your normal model and tools, so a message costs the same as typing it in a terminal.",
        "Runs you start are logged under ~/.hermes-web/runs so a page reload does not lose them.",
        "To change models, plugins, or cron jobs, use the terminal. This console reports state, it does not reconfigure Hermes.",
      ];
      for (const item of items) ul.appendChild(h("li", { text: item }));
      limits.appendChild(ul);
      nodes.push(limits);

      const note = h("p", { class: "hint", style: "margin-top:16px" });
      note.appendChild(icon("terminal", 13));
      note.appendChild(
        document.createTextNode(
          " Stop the console with Ctrl+C in the terminal that started it. If you closed that terminal, find it with: pgrep -af 'server.py'",
        ),
      );
      nodes.push(note);

      return nodes;
    },
  );

  return root;
}
