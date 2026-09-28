/** Plugins: what is installed, what is on, and the tools they contribute. */

import { api, type Plugin, type PluginsResponse, type ToolsResponse } from "./api.js";
import { clear, h, icon } from "./dom.js";
import { createAsyncBox, emptyState, pageHeader } from "./view-kit.js";

function statusChip(plugin: Plugin): HTMLElement {
  const status = (plugin.status ?? "unknown").toLowerCase();
  if (status.startsWith("enabled")) return h("span", { class: "chip chip-ok" }, icon("check", 12), "enabled");
  if (status.includes("not enabled")) return h("span", { class: "chip" }, icon("x", 12), "off");
  if (status.includes("error")) return h("span", { class: "chip chip-err" }, icon("triangle-alert", 12), "error");
  return h("span", { class: "chip" }, status);
}

export function renderPlugins(): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Plugins",
      "Every plugin manifest on this machine, user-installed first. Enable or disable with `hermes plugins enable <name>` in a terminal; this view reports state and never changes it.",
    ),
  );

  let filter = "";

  const toolbar = h("div", { class: "toolbar" });
  const searchWrap = h("div", { class: "search" });
  const searchInput = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search plugins",
    "aria-label": "Search plugins",
    autocomplete: "off",
  });
  searchWrap.appendChild(icon("search", 16));
  searchWrap.appendChild(searchInput);
  const reload = h("button", { class: "btn", type: "button" }, icon("refresh-cw", 16), "Reload");
  toolbar.appendChild(searchWrap);
  toolbar.appendChild(reload);
  root.appendChild(toolbar);

  const box = createAsyncBox();
  root.appendChild(box.el);

  function paint(data: PluginsResponse, tools: ToolsResponse): void {
    const q = filter.trim().toLowerCase();
    const plugins = q
      ? data.plugins.filter((p) =>
          `${p.name ?? ""} ${p.description ?? ""} ${p.source ?? ""}`.toLowerCase().includes(q),
        )
      : data.plugins;

    clear(box.el);
    if (plugins.length === 0) {
      box.el.appendChild(
        emptyState("No plugin matches that", `Nothing matches "${filter.trim()}". Try a shorter word.`, {
          label: "Clear search",
          onClick: () => {
            filter = "";
            searchInput.value = "";
            paint(data, tools);
          },
        }),
      );
      return;
    }

    const stats = h("div", { class: "grid grid-3" });
    const s1 = h("div", { class: "stat" });
    s1.appendChild(h("span", { class: "stat-label", text: "Plugins installed" }));
    s1.appendChild(h("span", { class: "stat-value", text: String(data.total) }));
    s1.appendChild(h("span", { class: "stat-note", text: `${data.enabled} enabled` }));
    const s2 = h("div", { class: "stat" });
    s2.appendChild(h("span", { class: "stat-label", text: "Tools available" }));
    s2.appendChild(h("span", { class: "stat-value", text: String(tools.enabled_count) }));
    s2.appendChild(h("span", { class: "stat-note", text: `of ${tools.total} registered` }));
    const s3 = h("div", { class: "stat" });
    s3.appendChild(h("span", { class: "stat-label", text: "Plugin tool sets" }));
    s3.appendChild(h("span", { class: "stat-value", text: String(tools.plugin.filter((t) => t.enabled).length) }));
    s3.appendChild(h("span", { class: "stat-note", text: "enabled right now" }));
    stats.appendChild(s1);
    stats.appendChild(s2);
    stats.appendChild(s3);
    box.el.appendChild(stats);

    const list = h("div", { class: "panel", style: "margin-top:16px" });
    const rows = h("div", { class: "rows" });
    for (const plugin of plugins) {
      const row = h("div", {
        class: "row row-static",
        style: "align-items:flex-start;padding-top:14px;padding-bottom:14px",
      });
      const main = h("div", { class: "row-main" });
      const titleLine = h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap" });
      titleLine.appendChild(h("span", { class: "row-title", text: plugin.name ?? "unnamed" }));
      titleLine.appendChild(statusChip(plugin));
      if (plugin.version) titleLine.appendChild(h("span", { class: "chip", text: `v${plugin.version}` }));
      if (plugin.source) {
        titleLine.appendChild(
          h("span", { class: `chip ${plugin.source === "user" ? "chip-accent" : ""}`, text: plugin.source }),
        );
      }
      main.appendChild(titleLine);
      main.appendChild(
        h("div", {
          class: "row-sub",
          style: "white-space:normal;margin-top:6px;line-height:1.5",
          text: plugin.description || "This manifest carries no description.",
        }),
      );
      const facts: string[] = [];
      if (plugin.provides_tools?.length) facts.push(`tools: ${plugin.provides_tools.join(", ")}`);
      if (plugin.provides_commands?.length) facts.push(`commands: /${plugin.provides_commands.join(", /")}`);
      if (plugin.hooks?.length) facts.push(`${plugin.hooks.length} hooks`);
      if (facts.length) {
        main.appendChild(h("div", { class: "row-sub", style: "margin-top:6px", text: facts.join("  |  ") }));
      }
      row.appendChild(main);
      rows.appendChild(row);
    }
    list.appendChild(rows);
    box.el.appendChild(list);

    const note = h("p", { class: "hint", style: "margin-top:12px" });
    note.appendChild(icon("circle-alert", 13));
    note.appendChild(
      document.createTextNode(
        data.confirmed_by_cli
          ? " Enabled state comes from the plugin manifests on disk, cross-checked against `hermes plugins list`."
          : ` Enabled state comes from the plugin manifests on disk. The CLI check did not answer${data.cli_error ? `: ${data.cli_error}` : "."}`,
      ),
    );
    box.el.appendChild(note);
  }

  let lastData: PluginsResponse | null = null;
  let lastTools: ToolsResponse | null = null;

  async function load(force: boolean): Promise<void> {
    clear(box.el);
    box.el.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const [data, tools] = await Promise.all([api.plugins(force), api.tools()]);
      lastData = data;
      lastTools = tools;
      paint(data, tools);
    } catch (err) {
      clear(box.el);
      const message = err instanceof Error ? err.message : String(err);
      box.el.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          icon("triangle-alert", 28),
          h("h3", { text: "Could not load plugins" }),
          h("p", { text: message }),
          h("button", { class: "btn", type: "button", onclick: () => void load(true) }, "Try again"),
        ),
      );
    }
  }

  searchInput.addEventListener("input", () => {
    filter = searchInput.value;
    if (lastData && lastTools) paint(lastData, lastTools);
  });
  reload.addEventListener("click", () => void load(true));

  void load(false);
  return root;
}
