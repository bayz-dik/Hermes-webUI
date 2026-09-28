/** Shared view scaffolding: async loading with the three real states.
 *
 * Every view renders loading, then either content, empty, or error. A view that
 * only implements the success branch is a defect, so this helper makes the other
 * two the path of least resistance.
 */

import { clear, h, icon } from "./dom.js";

export interface AsyncBox {
  readonly el: HTMLElement;
  load<T>(fetcher: () => Promise<T>, render: (data: T) => Node | Node[]): Promise<void>;
}

export function skeletonRows(count: number, height = 52): HTMLElement {
  const wrap = h("div", { class: "rows" });
  for (let i = 0; i < count; i += 1) {
    const row = h("div", { class: "skeleton skel-row" });
    row.style.height = `${height}px`;
    row.style.opacity = String(1 - i * 0.12);
    wrap.appendChild(row);
  }
  return wrap;
}

export function errorState(message: string, retry?: () => void): HTMLElement {
  const box = h("div", { class: "state state-error", role: "alert" });
  box.appendChild(icon("triangle-alert", 28));
  box.appendChild(h("h3", { text: "Could not load this view" }));
  box.appendChild(h("p", { text: message }));
  if (retry) {
    box.appendChild(
      h("button", { class: "btn", type: "button", onclick: retry }, icon("refresh-cw", 16), "Try again"),
    );
  }
  return box;
}

export function emptyState(title: string, body: string, action?: { label: string; onClick: () => void }): HTMLElement {
  const box = h("div", { class: "state" });
  box.appendChild(icon("inbox", 28));
  box.appendChild(h("h3", { text: title }));
  box.appendChild(h("p", { text: body }));
  if (action) {
    box.appendChild(h("button", { class: "btn", type: "button", onclick: action.onClick }, action.label));
  }
  return box;
}

export function loadingState(label: string): HTMLElement {
  const box = h("div", { class: "state" });
  const spin = icon("loader-circle", 26);
  spin.classList.add("spin");
  box.appendChild(spin);
  box.appendChild(h("p", { text: label }));
  return box;
}

export function createAsyncBox(): AsyncBox {
  const el = h("div", { class: "async-box" });
  let seq = 0;

  async function load<T>(fetcher: () => Promise<T>, render: (data: T) => Node | Node[]): Promise<void> {
    const mine = ++seq;
    clear(el);
    el.appendChild(skeletonRows(5));
    try {
      const data = await fetcher();
      if (mine !== seq) return; // a newer load superseded this one
      clear(el);
      const out = render(data);
      if (Array.isArray(out)) {
        for (const node of out) el.appendChild(node);
      } else {
        el.appendChild(out);
      }
    } catch (err) {
      if (mine !== seq) return;
      clear(el);
      const message = err instanceof Error ? err.message : String(err);
      el.appendChild(errorState(message, () => void load(fetcher, render)));
    }
  }

  return { el, load };
}

export function pageHeader(title: string, subtitle: string, actions?: Node[]): HTMLElement {
  const head = h("div", { class: "section-head" });
  const text = h("div", { style: "flex:1 1 260px;min-width:0" });
  text.appendChild(h("h2", { text: title }));
  if (subtitle) text.appendChild(h("p", { text: subtitle }));
  head.appendChild(text);
  for (const action of actions ?? []) head.appendChild(action);
  return head;
}
