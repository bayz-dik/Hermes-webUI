/** Model: switch the provider and default model from the browser.
 *
 * This is the one view that writes to Hermes config, so it is built to be
 * explicit about what it is about to change and to show the result rather than
 * claim it. The server validates every field and keeps a timestamped backup.
 */

import { api, type BuiltinProvider, type CustomProvider, type ModelsResponse } from "./api.js";
import { clear, h, icon } from "./dom.js";
import { createAsyncBox, emptyState, pageHeader } from "./view-kit.js";

interface Selection {
  model: string;
  provider: string;
  base_url: string;
  env_key: string;
}

export function renderModel(): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "Model",
      "Pick the provider and default model for new sessions. Changes are written to config.yaml with a backup, and apply to the next session you start.",
    ),
  );

  let data: ModelsResponse | null = null;
  let selection: Selection = { model: "", provider: "", base_url: "", env_key: "" };
  let dirty = false;

  const box = createAsyncBox();
  root.appendChild(box.el);

  const applyBar = h("div", { class: "panel panel-pad", style: "margin-bottom:16px;display:none" });
  const applyText = h("div", { class: "row-sub", style: "white-space:normal" });
  const applyBtn = h("button", { class: "btn btn-primary", type: "button" }, icon("check", 16), "Apply");
  const revertBtn = h("button", { class: "btn", type: "button" }, "Revert");
  const applyActions = h("div", { style: "display:flex;gap:8px;margin-top:12px;flex-wrap:wrap" }, applyBtn, revertBtn);
  applyBar.appendChild(applyText);
  applyBar.appendChild(applyActions);
  root.appendChild(applyBar);

  const result = h("div", { style: "margin-bottom:16px" });
  root.appendChild(result);

  // ---- add a provider -------------------------------------------------
  const addPanel = h("details", { class: "disclosure", style: "margin-bottom:16px" });
  const addSummary = h("summary");
  addSummary.appendChild(icon("plus", 16));
  addSummary.appendChild(document.createTextNode("Add an endpoint provider"));
  const chev = icon("chevron-right", 16);
  chev.classList.add("chev");
  addSummary.appendChild(chev);
  addPanel.appendChild(addSummary);

  const addBody = h("div", { class: "panel-pad" });
  const addForm = h("form");
  const fields = h("div", { class: "grid grid-2" });

  function field(labelText: string, input: HTMLElement, help: string): HTMLElement {
    const wrap = h("div", { class: "field" });
    wrap.appendChild(h("label", { for: input.id, text: labelText }));
    wrap.appendChild(input);
    if (help) wrap.appendChild(h("span", { class: "help", text: help }));
    return wrap;
  }

  const nameInput = h("input", { class: "input", id: "pv-name", type: "text", placeholder: "My endpoint", autocomplete: "off" });
  const urlInput = h("input", { class: "input", id: "pv-url", type: "url", placeholder: "https://api.example.com/v1", autocomplete: "off" });
  const keyInput = h("input", { class: "input", id: "pv-key", type: "password", placeholder: "sk-...", autocomplete: "off" });
  const modelInput = h("input", { class: "input", id: "pv-model", type: "text", placeholder: "gpt-4o-mini", autocomplete: "off" });
  const modelsArea = h("textarea", { class: "textarea", id: "pv-models", rows: 4, placeholder: "one model id per line (optional)" });

  fields.appendChild(field("Name", nameInput, "How it appears in this list."));
  fields.appendChild(field("Base URL", urlInput, "Must end at the API root, usually /v1."));
  fields.appendChild(field("API key", keyInput, "Stored in ~/.hermes/.env, never written into config.yaml."));
  fields.appendChild(field("Default model", modelInput, "Optional. Used when you switch to this provider."));
  addForm.appendChild(fields);

  const modelsField = h("div", { class: "field", style: "margin-top:12px" });
  modelsField.appendChild(h("label", { for: modelsArea.id, text: "Model list" }));
  modelsField.appendChild(modelsArea);
  modelsField.appendChild(
    h("span", { class: "help", text: "Optional. Leave empty and the provider still works; you just type the model id when switching." }),
  );
  addForm.appendChild(modelsField);

  const addError = h("p", { class: "error-text", style: "margin:12px 0 0" });
  addForm.appendChild(addError);

  const addActions = h("div", { style: "display:flex;gap:8px;margin-top:12px;flex-wrap:wrap" });
  const addBtn = h("button", { class: "btn btn-primary", type: "submit" }, icon("plus", 16), "Add provider");
  const addCancel = h("button", { class: "btn", type: "button" }, "Clear");
  addActions.appendChild(addBtn);
  addActions.appendChild(addCancel);
  addForm.appendChild(addActions);
  addBody.appendChild(addForm);
  addPanel.appendChild(addBody);
  root.appendChild(addPanel);

  addCancel.addEventListener("click", () => {
    for (const el of [nameInput, urlInput, keyInput, modelInput, modelsArea]) el.value = "";
    addError.textContent = "";
  });

  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitProvider();
  });

  async function submitProvider(): Promise<void> {
    addError.textContent = "";
    const name = nameInput.value.trim();
    const base_url = urlInput.value.trim();
    const api_key = keyInput.value.trim();
    if (!name || !base_url || !api_key) {
      addError.textContent = "Name, base URL, and API key are all required.";
      return;
    }
    addBtn.disabled = true;
    addBtn.replaceChildren(icon("loader-circle", 16), document.createTextNode("Adding"));
    try {
      const res = await api.addProvider({
        name,
        base_url,
        api_key,
        default_model: modelInput.value.trim(),
        models: modelsArea.value,
      });
      if (!res.ok) {
        addError.textContent = res.error ?? "The provider was refused.";
        return;
      }
      // Clear the key from the DOM as soon as it is stored.
      keyInput.value = "";
      for (const el of [nameInput, urlInput, modelInput, modelsArea]) el.value = "";
      showResult(
        true,
        `Added ${res.added}`,
        `${res.models_parsed ?? 0} models registered, key stored as ${res.env_key}. Backup: ${res.backup}. ${res.note ?? ""}`,
      );
      addPanel.open = false;
      await load();
    } catch (err) {
      addError.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      addBtn.disabled = false;
      addBtn.replaceChildren(icon("plus", 16), document.createTextNode("Add provider"));
    }
  }

  function currentOf(d: ModelsResponse): Selection {
    const base = d.current.base_url ?? "";
    const custom = d.custom_providers.find((p) => p.base_url === base);
    return {
      model: d.current.model ?? "",
      provider: d.current.provider ?? "",
      base_url: base,
      env_key: custom?.env_key ?? "",
    };
  }

  function setSelection(next: Partial<Selection>, label: string): void {
    selection = { ...selection, ...next };
    dirty = true;
    applyText.textContent = `Ready to switch to ${label}. This writes config.yaml (a timestamped backup is kept first).`;
    applyBar.style.display = "block";
  }

  function showResult(ok: boolean, message: string, detail?: string): void {
    clear(result);
    const panel = h("div", { class: `state ${ok ? "" : "state-error"}`, style: "align-items:flex-start;text-align:left" });
    panel.appendChild(icon(ok ? "circle-check" : "triangle-alert", 22));
    const body = h("div");
    body.appendChild(h("h3", { text: message }));
    if (detail) body.appendChild(h("p", { text: detail }));
    panel.appendChild(body);
    result.appendChild(panel);
  }

  async function apply(): Promise<void> {
    if (!data) return;
    applyBtn.disabled = true;
    applyBtn.replaceChildren(icon("loader-circle", 16), document.createTextNode("Applying"));
    try {
      const payload: { model: string; provider?: string; base_url?: string; env_key?: string } = {
        model: selection.model,
      };
      if (selection.base_url) {
        payload.base_url = selection.base_url;
        if (selection.env_key) payload.env_key = selection.env_key;
      } else {
        payload.provider = selection.provider;
      }
      const res = await api.setModel(payload);
      if (!res.ok) {
        showResult(false, "The switch was refused", res.error ?? "No reason given.");
        return;
      }
      const now = res.now ?? {};
      showResult(
        true,
        res.applied ? "Model switched" : "Written, but the read-back did not match",
        `${now.model} on ${now.provider}${now.base_url ? ` (${now.base_url})` : ""}. Backup: ${res.backup}. ${res.note ?? ""}`,
      );
      dirty = false;
      applyBar.style.display = "none";
      await load();
    } catch (err) {
      showResult(false, "The switch failed", err instanceof Error ? err.message : String(err));
    } finally {
      applyBtn.disabled = false;
      applyBtn.replaceChildren(icon("check", 16), document.createTextNode("Apply"));
    }
  }

  applyBtn.addEventListener("click", () => void apply());
  revertBtn.addEventListener("click", () => {
    if (data) selection = currentOf(data);
    dirty = false;
    applyBar.style.display = "none";
    paint();
  });

  // ---- provider cards -------------------------------------------------
  function providerCard(
    title: string,
    subtitle: string,
    meta: HTMLElement[],
    models: string[],
    active: boolean,
    onPick: (model: string) => void,
    note: string,
  ): HTMLElement {
    const panel = h("div", { class: "panel", style: active ? "border-color:var(--accent)" : "" });
    const head = h("div", { class: "panel-pad", style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--line)" });
    const text = h("div", { style: "flex:1 1 200px;min-width:0" });
    text.appendChild(h("div", { class: "row-title", text: title }));
    text.appendChild(h("div", { class: "row-sub", text: subtitle }));
    head.appendChild(text);
    for (const m of meta) head.appendChild(m);
    panel.appendChild(head);

    if (note) {
      const n = h("p", { class: "hint", style: "margin:0;padding:10px 16px" });
      n.appendChild(icon("circle-alert", 13));
      n.appendChild(document.createTextNode(` ${note}`));
      panel.appendChild(n);
    }

    if (models.length === 0) {
      panel.appendChild(
        h("p", { class: "hint", style: "margin:0;padding:12px 16px", text: "This provider lists no models." }),
      );
      return panel;
    }

    const rows = h("div", { class: "rows", style: "max-height:280px;overflow-y:auto" });
    for (const model of models) {
      const chosen = active && selection.model === model;
      const row = h("button", { class: "row", type: "button", "aria-current": chosen ? "true" : "false" });
      const main = h("div", { class: "row-main" });
      main.appendChild(h("div", { class: "row-title", style: "font-family:var(--font-mono);font-size:12px", text: model }));
      row.appendChild(main);
      if (chosen) row.appendChild(h("span", { class: "chip chip-accent" }, icon("check", 12), "current"));
      else row.appendChild(h("span", { class: "row-meta", text: "use" }));
      row.addEventListener("click", () => onPick(model));
      rows.appendChild(row);
    }
    panel.appendChild(rows);
    return panel;
  }

  function paint(): void {
    if (!data) return;
    clear(box.el);
    const d = data;
    const current = currentOf(d);

    // -- current state --
    const stats = h("div", { class: "grid grid-3" });
    const s1 = h("div", { class: "stat" });
    s1.appendChild(h("span", { class: "stat-label", text: "Model now" }));
    s1.appendChild(h("span", { class: "stat-value", style: "font-size:18px", text: current.model || "not set" }));
    s1.appendChild(h("span", { class: "stat-note", text: current.provider || "unknown provider" }));
    const s2 = h("div", { class: "stat" });
    s2.appendChild(h("span", { class: "stat-label", text: "Endpoint" }));
    s2.appendChild(h("span", { class: "stat-value", style: "font-size:15px", text: current.base_url || "provider default" }));
    s2.appendChild(h("span", { class: "stat-note", text: current.base_url ? "explicit base_url" : "uses the provider's own endpoint" }));
    const s3 = h("div", { class: "stat" });
    s3.appendChild(h("span", { class: "stat-label", text: "Providers with a key" }));
    s3.appendChild(h("span", { class: "stat-value", text: String(d.custom_providers.length) }));
    s3.appendChild(h("span", { class: "stat-note", text: `custom · ${d.usable_builtin} builtin ready` }));
    stats.appendChild(s1);
    stats.appendChild(s2);
    stats.appendChild(s3);
    box.el.appendChild(stats);

    // -- custom providers --
    const customHead = h("h3", { style: "margin:24px 0 12px;font-size:15px;font-weight:600", text: "Custom providers" });
    box.el.appendChild(customHead);
    if (d.custom_providers.length === 0) {
      box.el.appendChild(
        emptyState("No custom providers", "Add one to config.yaml under `custom_providers`, then reload this view."),
      );
    }
    for (const p of d.custom_providers) {
      const active = p.base_url === current.base_url;
      const meta: HTMLElement[] = [];
      meta.push(h("span", { class: "chip", text: `${p.models.length} models` }));
      meta.push(
        p.key_present
          ? h("span", { class: "chip chip-ok" }, icon("check", 12), "key set")
          : h("span", { class: "chip chip-err" }, icon("triangle-alert", 12), "no key"),
      );
      if (active) meta.push(h("span", { class: "chip chip-accent" }, "in use"));
      box.el.appendChild(
        providerCard(
          p.name,
          p.base_url,
          meta,
          p.models,
          active,
          (model) => setSelection({ model, base_url: p.base_url, env_key: p.env_key, provider: "custom" }, `${model} on ${p.name}`),
          p.key_present ? "" : `${p.env_key || "its API key"} is not set in .env, so this provider will fail on the first call.`,
        ),
      );
      box.el.appendChild(h("div", { style: "height:12px" }));
    }

    // -- builtin providers --
    const builtinHead = h("h3", { style: "margin:24px 0 12px;font-size:15px;font-weight:600", text: "Builtin providers" });
    box.el.appendChild(builtinHead);

    // -- manual model id --
    const manualPanel = h("div", { class: "panel panel-pad", style: "margin-bottom:12px" });
    manualPanel.appendChild(h("div", { class: "row-title", text: "Use a model id directly" }));
    manualPanel.appendChild(
      h("div", { class: "row-sub", style: "margin:4px 0 10px;white-space:normal", text: "For a model that is not listed above. It is written as-is, with the current endpoint." }),
    );
    const manualRow = h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
    const manualInput = h("input", {
      class: "input",
      type: "text",
      placeholder: "exact model id",
      "aria-label": "Model id",
      style: "flex:1 1 240px;min-width:0",
      autocomplete: "off",
    });
    const manualBtn = h("button", { class: "btn", type: "button" }, "Use this model");
    manualBtn.addEventListener("click", () => {
      const value = manualInput.value.trim();
      if (!value) return;
      setSelection(
        { model: value, provider: current.provider || "custom", base_url: current.base_url, env_key: current.env_key },
        value,
      );
    });
    manualRow.appendChild(manualInput);
    manualRow.appendChild(manualBtn);
    manualPanel.appendChild(manualRow);
    box.el.appendChild(manualPanel);

    const ready = d.builtin_providers.filter((p: BuiltinProvider) => p.key_present);
    const rest = d.builtin_providers.filter((p: BuiltinProvider) => !p.key_present);
    const search = h("input", {
      class: "input",
      type: "search",
      placeholder: `Search ${d.builtin_providers.length} providers`,
      "aria-label": "Search providers",
      style: "margin-bottom:12px",
    });
    box.el.appendChild(search);

    const listWrap = h("div");
    box.el.appendChild(listWrap);

    function paintBuiltin(q: string): void {
      clear(listWrap);
      const term = q.trim().toLowerCase();
      const match = (p: BuiltinProvider): boolean =>
        !term || p.name.toLowerCase().includes(term) || p.id.toLowerCase().includes(term) ||
        p.models.some((m) => m.toLowerCase().includes(term));

      const shownReady = ready.filter(match);
      const shownRest = term ? rest.filter(match) : [];
      const visible = [...shownReady, ...shownRest].slice(0, term ? 40 : 12);

      if (visible.length === 0) {
        // Two different situations, two different messages: an empty search
        // result is the user's doing, an empty ready-list is the install's.
        if (term) {
          listWrap.appendChild(
            emptyState("No provider matches that", `Nothing matches "${q.trim()}". Try a shorter word.`),
          );
        } else {
          listWrap.appendChild(
            emptyState(
              "No builtin provider has a key yet",
              `None of the ${d.builtin_providers.length} builtin providers has its key in ~/.hermes/.env. Search above to browse them, or add an endpoint provider at the top of this page.`,
            ),
          );
        }
        return;
      }

      for (const p of visible) {
        const meta: HTMLElement[] = [];
        meta.push(h("span", { class: "chip", text: `${p.models.length} models` }));
        if (p.key_present) meta.push(h("span", { class: "chip chip-ok" }, icon("check", 12), "key set"));
        else meta.push(h("span", { class: "chip", text: "no key" }));
        listWrap.appendChild(
          providerCard(
            p.name,
            p.id,
            meta,
            p.models.slice(0, 60),
            false,
            (model) => setSelection({ model, provider: p.id, base_url: "", env_key: "" }, `${model} on ${p.name}`),
            p.key_present ? "" : `Set ${p.env_keys[0] ?? "its API key"} in .env first, or the first call will fail.`,
          ),
        );
        listWrap.appendChild(h("div", { style: "height:12px" }));
      }
      if (!term && rest.length > 0) {
        listWrap.appendChild(
          h("p", {
            class: "hint",
            style: "margin-top:4px",
            text: `${ready.length} of ${d.builtin_providers.length} providers have a key in .env. The rest are hidden until you search, or until you add their key.`,
          }),
        );
      }
    }

    paintBuiltin("");
    search.addEventListener("input", () => paintBuiltin(search.value));
  }

  async function load(): Promise<void> {
    clear(box.el);
    box.el.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const res = await api.models();
      if (res.error) throw new Error(res.error);
      data = res;
      if (!dirty) selection = currentOf(res);
      paint();
    } catch (err) {
      clear(box.el);
      const message = err instanceof Error ? err.message : String(err);
      box.el.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          icon("triangle-alert", 28),
          h("h3", { text: "Could not load providers" }),
          h("p", { text: message }),
          h("button", { class: "btn", type: "button", onclick: () => void load() }, "Try again"),
        ),
      );
    }
  }

  void load();
  return root;
}

export function customProviderLabel(p: CustomProvider): string {
  return `${p.name} (${p.base_url})`;
}
