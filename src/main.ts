/** Application shell: navigation, hash routing, and the mobile drawer. */

import { api } from "./api.js";
import { announce, clear, h, icon } from "./dom.js";
import type { IconName } from "./icons.js";
import { renderActivity } from "./view-activity.js";
import { renderChat } from "./view-chat.js";
import { renderCron } from "./view-cron.js";
import { renderHistory } from "./view-history.js";
import { renderModel } from "./view-model.js";
import { renderOverview } from "./view-overview.js";
import { renderPlugins } from "./view-plugins.js";
import { renderSettings } from "./view-settings.js";
import { renderSkills } from "./view-skills.js";
import { renderWork } from "./view-work.js";

interface Route {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly icon: IconName;
  readonly render: (param: string) => HTMLElement;
}

const ROUTES: readonly Route[] = [
  { id: "overview", label: "Overview", title: "Overview", icon: "gauge", render: () => renderOverview() },
  { id: "chat", label: "Chat", title: "Chat", icon: "message-square", render: (p) => renderChat(p) },
  { id: "work", label: "Work", title: "Work", icon: "activity", render: (p) => renderWork(p) },
  { id: "history", label: "History", title: "History", icon: "brain", render: (p) => renderHistory(p) },
  { id: "model", label: "Model", title: "Model", icon: "settings", render: () => renderModel() },
  { id: "skills", label: "Skills", title: "Skills", icon: "sparkles", render: () => renderSkills() },
  { id: "plugins", label: "Plugins", title: "Plugins", icon: "plug", render: () => renderPlugins() },
  { id: "activity", label: "Activity", title: "Activity", icon: "loader-circle", render: () => renderActivity() },
  { id: "cron", label: "Cron", title: "Cron", icon: "clock", render: () => renderCron() },
  { id: "settings", label: "Settings", title: "Settings", icon: "terminal", render: () => renderSettings() },
];

const DEFAULT_ROUTE = "overview";

function brandMark(): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("class", "brand-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "32");
  bg.setAttribute("height", "32");
  bg.setAttribute("rx", "4");
  bg.setAttribute("fill", "var(--surface-3)");
  const stroke = document.createElementNS(NS, "path");
  stroke.setAttribute("d", "M10 9.5 L16 22 L22 9.5");
  stroke.setAttribute("fill", "none");
  stroke.setAttribute("stroke", "var(--accent)");
  stroke.setAttribute("stroke-width", "2.4");
  stroke.setAttribute("stroke-linecap", "square");
  const tick = document.createElementNS(NS, "line");
  tick.setAttribute("x1", "16");
  tick.setAttribute("y1", "14.5");
  tick.setAttribute("x2", "16");
  tick.setAttribute("y2", "17.5");
  tick.setAttribute("stroke", "var(--text)");
  tick.setAttribute("stroke-width", "2.4");
  tick.setAttribute("stroke-linecap", "square");
  svg.append(bg, stroke, tick);
  return svg;
}

function parseHash(): { id: string; param: string } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [id = "", ...rest] = raw.split("/");
  const known = ROUTES.some((r) => r.id === id);
  return { id: known ? id : DEFAULT_ROUTE, param: rest.join("/") };
}

function boot(): void {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Missing #root element in index.html");
  }

  let navButtons = new Map<string, HTMLButtonElement>();
  let current = "";
  let currentParam: string | null = null;

  // ------------------------------------------------------------- rail
  const rail = h("nav", { class: "rail", id: "rail", "aria-label": "Main" });
  const brand = h("div", { class: "brand" });
  brand.appendChild(brandMark());
  const brandText = h("div", { style: "min-width:0" });
  brandText.appendChild(h("div", { class: "brand-name", text: "Hermes" }));
  const brandSub = h("div", { class: "brand-sub", text: "console" });
  brandText.appendChild(brandSub);
  brand.appendChild(brandText);
  const closeBtn = h(
    "button",
    { class: "btn btn-icon drawer-close", type: "button", "aria-label": "Close navigation", style: "margin-left:auto" },
    icon("x", 18),
  );
  brand.appendChild(closeBtn);
  rail.appendChild(brand);

  const nav = h("div", { class: "nav" });
  nav.appendChild(h("div", { class: "nav-label", text: "Workspace" }));
  for (const route of ROUTES) {
    const btn = h(
      "button",
      { class: "nav-item", type: "button", "aria-current": "false" },
      icon(route.icon, 17),
      h("span", { text: route.label }),
    );
    btn.addEventListener("click", () => {
      window.location.hash = `#/${route.id}`;
      closeDrawer();
    });
    nav.appendChild(btn);
    navButtons.set(route.id, btn);
  }
  rail.appendChild(nav);

  const foot = h("div", { class: "rail-foot" });
  const health = h("div", { class: "status-line" });
  const healthDot = h("span", { class: "dot dot-idle" });
  const healthText = h("span", { text: "checking server" });
  health.appendChild(healthDot);
  health.appendChild(healthText);
  foot.appendChild(health);
  const versionLine = h("div", { class: "status-line" }, h("span", { text: "reading install..." }));
  foot.appendChild(versionLine);
  rail.appendChild(foot);

  // ------------------------------------------------------------- main
  const main = h("div", { class: "main", id: "main" });
  const bar = h("header", { class: "bar" });
  const burger = h(
    "button",
    { class: "btn btn-icon hamburger", type: "button", "aria-label": "Open navigation", "aria-expanded": "false", "aria-controls": "rail" },
    icon("menu", 18),
  );
  const title = h("h1", { text: "Overview" });
  const barActions = h("div", { class: "bar-actions" });
  bar.appendChild(burger);
  bar.appendChild(title);
  bar.appendChild(h("span", { class: "spacer" }));
  bar.appendChild(barActions);
  main.appendChild(bar);

  const content = h("div", { class: "content", id: "main-content" });
  main.appendChild(content);

  const scrim = h("div", { class: "scrim" });
  scrim.addEventListener("click", () => closeDrawer());

  clear(root);
  root.append(rail, main, scrim);

  // --------------------------------------------------------- drawer
  function openDrawer(): void {
    document.body.classList.add("drawer-open");
    burger.setAttribute("aria-expanded", "true");
    closeBtn.focus();
  }
  function closeDrawer(): void {
    if (!document.body.classList.contains("drawer-open")) return;
    document.body.classList.remove("drawer-open");
    burger.setAttribute("aria-expanded", "false");
    burger.focus();
  }
  burger.addEventListener("click", openDrawer);
  closeBtn.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });

  // ---------------------------------------------------------- routing
  function navigate(): void {
    const { id, param } = parseHash();
    // Re-render when the route param changes too: #/chat and #/chat/<session>
    // are different screens, and the bare-id guard would block that switch.
    if (id === current && param === currentParam) return;
    current = id;
    currentParam = param;
    const route = ROUTES.find((r) => r.id === id) ?? ROUTES[0];
    if (!route) return;

    for (const [key, btn] of navButtons) {
      btn.setAttribute("aria-current", key === id ? "page" : "false");
    }
    title.textContent = route.title;
    document.title = `${route.title} · Hermes Console`;
    clear(content);
    try {
      content.appendChild(route.render(param));
    } catch (err) {
      const box = h("div", { class: "state state-error", role: "alert" });
      box.appendChild(icon("triangle-alert", 28));
      box.appendChild(h("h3", { text: "This view failed to render" }));
      box.appendChild(h("p", { text: err instanceof Error ? err.message : String(err) }));
      box.appendChild(
        h(
          "button",
          { class: "btn", type: "button", onclick: () => window.location.reload() },
          icon("refresh-cw", 16),
          "Reload the console",
        ),
      );
      content.appendChild(box);
    }
    content.scrollIntoView({ block: "start" });
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", navigate);
  navigate();

  // ----------------------------------------------------- server health
  async function pollHealth(): Promise<void> {
    try {
      const system = await api.system();
      healthDot.className = "dot dot-ok";
      healthText.textContent = "server reachable";
      versionLine.textContent = system.version ? `hermes ${system.version}` : "version unknown";
      brandSub.textContent = system.config.model ?? "console";
    } catch (err) {
      healthDot.className = "dot dot-err";
      healthText.textContent = "server unreachable";
      versionLine.textContent = err instanceof Error ? err.message.slice(0, 60) : "unknown error";
    }
  }
  void pollHealth();
  window.setInterval(() => void pollHealth(), 30000);

  announce("Hermes Console ready.");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
