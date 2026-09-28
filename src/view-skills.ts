/** Skills: the library on this machine, searchable and readable. */

import { api, type Skill } from "./api.js";
import { bytes, clear, h, icon } from "./dom.js";
import { createAsyncBox, emptyState, pageHeader } from "./view-kit.js";

const SYNONYMS: Record<string, string[]> = {
  design: ["ui", "ux", "frontend", "visual", "taste", "layout"],
  tampilan: ["ui", "ux", "visual", "frontend"],
  tulis: ["writing", "copy", "prose", "humanizer"],
  tulisankode: ["code", "review", "refactor"],
  uji: ["test", "tdd", "qa", "verify"],
  tes: ["test", "tdd", "qa", "verify"],
  debug: ["diagnose", "bug", "systematic"],
  rencana: ["plan", "spec", "tickets", "wayfinder"],
  desain: ["design", "ui", "visual"],
};

function expand(query: string): string[] {
  const q = query.toLowerCase().trim();
  const terms = [q];
  for (const [key, values] of Object.entries(SYNONYMS)) {
    if (q.includes(key)) terms.push(...values);
  }
  return terms;
}

export function renderSkills(): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader("Skills", "Every SKILL.md installed for this Hermes. Open one to read it. Search matches names and descriptions."),
  );

  let query = "";
  let category = "all";
  let all: Skill[] = [];

  const toolbar = h("div", { class: "toolbar" });
  const searchWrap = h("div", { class: "search" });
  const searchInput = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search skills",
    "aria-label": "Search skills",
    autocomplete: "off",
  });
  searchWrap.appendChild(icon("search", 16));
  searchWrap.appendChild(searchInput);
  const refresh = h(
    "button",
    { class: "btn", type: "button" },
    icon("refresh-cw", 16),
    "Reload",
  );
  toolbar.appendChild(searchWrap);
  toolbar.appendChild(refresh);
  root.appendChild(toolbar);

  const catWrap = h("div", { class: "cat-list", style: "margin-bottom:16px" });
  root.appendChild(catWrap);

  const box = createAsyncBox();
  root.appendChild(box.el);

  const countLine = h("p", { class: "hint", style: "margin:0 0 12px" });
  root.insertBefore(countLine, box.el);

  function matches(skill: Skill, terms: string[]): boolean {
    const hay = `${skill.name} ${skill.description} ${skill.folder} ${skill.category}`.toLowerCase();
    return terms.some((t) => t.length > 1 && hay.includes(t));
  }

  function paint(): void {
    const terms = expand(query);
    const filtered = all.filter((s) => {
      if (category !== "all" && s.category !== category) return false;
      if (!query.trim()) return true;
      return matches(s, terms);
    });

    countLine.textContent =
      query.trim() || category !== "all"
        ? `${filtered.length} of ${all.length} skills`
        : `${all.length} skills across ${new Set(all.map((s) => s.category)).size} categories`;

    clear(box.el);
    if (filtered.length === 0) {
      box.el.appendChild(
        emptyState(
          "No skill matches that",
          `Nothing in ${category === "all" ? "any category" : `the ${category} category`} matches "${query.trim()}". Try a broader word, or clear the filters.`,
          {
            label: "Clear filters",
            onClick: () => {
              query = "";
              category = "all";
              searchInput.value = "";
              paintCategories();
              paint();
            },
          },
        ),
      );
      return;
    }

    const list = h("div", { class: "panel" });
    const rows = h("div", { class: "rows" });
    for (const skill of filtered) {
      rows.appendChild(skillRow(skill));
    }
    list.appendChild(rows);
    box.el.appendChild(list);
  }

  function paintCategories(): void {
    clear(catWrap);
    const counts = new Map<string, number>();
    for (const s of all) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    const options: [string, number][] = [["all", all.length], ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))];
    for (const [name, count] of options) {
      catWrap.appendChild(
        h(
          "button",
          {
            type: "button",
            "aria-pressed": category === name ? "true" : "false",
            onclick: () => {
              category = name;
              paintCategories();
              paint();
            },
          },
          name === "all" ? "All" : name,
          h("span", { class: "n", text: String(count) }),
        ),
      );
    }
  }

  function skillRow(skill: Skill): HTMLElement {
    const row = h("button", { class: "row", type: "button" });
    const main = h("div", { class: "row-main" });
    main.appendChild(h("div", { class: "row-title", text: skill.name }));
    main.appendChild(h("div", { class: "row-sub", text: skill.description || "No description in frontmatter." }));
    row.appendChild(main);
    row.appendChild(h("div", { class: "row-meta", text: skill.category }));
    row.addEventListener("click", () => void openSkill(skill));
    return row;
  }

  async function openSkill(skill: Skill): Promise<void> {
    clear(box.el);
    box.el.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const body = await api.skill(skill.abs_path);
      clear(box.el);
      const panel = h("div", { class: "panel" });
      const head = h("div", { class: "panel-pad", style: "display:flex;align-items:center;gap:12px;flex-wrap:wrap" });
      const back = h(
        "button",
        { class: "btn", type: "button", onclick: () => paint() },
        icon("arrow-left", 16),
        "Back to list",
      );
      const title = h("div", { style: "flex:1 1 200px;min-width:0" });
      title.appendChild(h("div", { class: "row-title", text: skill.name }));
      title.appendChild(h("div", { class: "row-sub", text: `${body.path} · ${body.lines} lines · ${bytes(skill.bytes)}` }));
      const copy = h("button", { class: "btn", type: "button" }, icon("copy", 16), "Copy path");
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(body.path).then(
          () => {
            copy.replaceChildren(icon("check", 16), document.createTextNode("Copied"));
            setTimeout(() => copy.replaceChildren(icon("copy", 16), document.createTextNode("Copy path")), 1600);
          },
          () => {
            copy.replaceChildren(document.createTextNode("Copy failed"));
          },
        );
      });
      head.appendChild(back);
      head.appendChild(title);
      head.appendChild(copy);
      panel.appendChild(head);
      const pre = h("pre", { class: "code", style: "border-top:1px solid var(--line);border-radius:0" });
      pre.textContent = body.content;
      panel.appendChild(pre);
      box.el.appendChild(panel);
    } catch (err) {
      clear(box.el);
      box.el.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          h("p", { text: `Could not read ${skill.path}: ${err instanceof Error ? err.message : String(err)}` }),
          h("button", { class: "btn", type: "button", onclick: () => paint() }, "Back to list"),
        ),
      );
    }
  }

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    paint();
  });
  refresh.addEventListener("click", () => {
    void load(true);
  });

  async function load(force: boolean): Promise<void> {
    clear(box.el);
    box.el.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const data = await api.skills({ force });
      all = data.skills;
      paintCategories();
      paint();
    } catch (err) {
      clear(box.el);
      const message = err instanceof Error ? err.message : String(err);
      box.el.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          icon("triangle-alert", 28),
          h("h3", { text: "Could not load skills" }),
          h("p", { text: message }),
          h("button", { class: "btn", type: "button", onclick: () => void load(true) }, "Try again"),
        ),
      );
    }
  }

  void load(false);
  return root;
}
