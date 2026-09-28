/** History: browse past conversations and read any transcript.
 *
 * Deliberately separate from Chat. Chat is where you talk to the agent; this is
 * where you read what it did before. Mixing the two meant a session picker sat
 * inside the composer view and neither had room to be good.
 */

import { api, type MessageRow, type SessionRow } from "./api.js";
import { clear, clockTime, h, icon, num, relTime } from "./dom.js";
import { createAsyncBox, emptyState, pageHeader } from "./view-kit.js";

function roleLabel(role: string): string {
  if (role === "user") return "you";
  if (role === "assistant") return "hermes";
  if (role === "tool") return "tool";
  return role;
}

function messageEl(m: MessageRow): HTMLElement {
  const cls = m.role === "user" ? "user" : m.role === "tool" ? "tool" : "assistant";
  const wrap = h("div", { class: `msg msg-${cls}` });
  const head = h("div", { class: "msg-head" });
  head.appendChild(h("span", { text: m.tool_name ? `${roleLabel(m.role)} · ${m.tool_name}` : roleLabel(m.role) }));
  head.appendChild(h("span", { text: clockTime(m.timestamp) }));
  if (m.compacted) head.appendChild(h("span", { class: "chip", text: "compacted" }));
  wrap.appendChild(head);
  wrap.appendChild(h("div", { class: "msg-body", text: m.content ?? "" }));
  return wrap;
}

export function renderHistory(initialId = ""): HTMLElement {
  const root = h("div");
  root.appendChild(
    pageHeader(
      "History",
      "Every conversation stored on this machine, newest first. Read-only. To continue one, open Chat and pick it there.",
    ),
  );

  let query = "";
  let selected = initialId;
  let all: SessionRow[] = [];

  const toolbar = h("div", { class: "toolbar" });
  const searchWrap = h("div", { class: "search" });
  const searchInput = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search by title, id, or model",
    "aria-label": "Search conversations",
    autocomplete: "off",
  });
  searchWrap.appendChild(icon("search", 16));
  searchWrap.appendChild(searchInput);
  const countLine = h("span", { class: "hint" });
  toolbar.appendChild(searchWrap);
  toolbar.appendChild(countLine);
  root.appendChild(toolbar);

  const layout = h("div", { class: "chat-layout" });
  const listPanel = h("div", { class: "panel" });
  const listRows = h("div", { class: "rows", style: "max-height:72vh;overflow-y:auto" });
  listPanel.appendChild(listRows);
  const detailPanel = h("div", { class: "panel" });
  const detailHead = h("div", { class: "panel-pad", style: "border-bottom:1px solid var(--line)" });
  const detailBody = h("div", { class: "thread", style: "max-height:64vh;overflow-y:auto" });
  detailPanel.appendChild(detailHead);
  detailPanel.appendChild(detailBody);
  layout.appendChild(listPanel);
  layout.appendChild(detailPanel);
  root.appendChild(layout);

  function placeholder(): void {
    clear(detailHead);
    detailHead.appendChild(h("div", { class: "row-title", text: "Pick a conversation" }));
    detailHead.appendChild(h("div", { class: "row-sub", text: "The full transcript appears here." }));
    clear(detailBody);
    detailBody.appendChild(
      emptyState("Nothing selected", "Choose a conversation on the left to read its messages and tool calls."),
    );
  }

  async function openDetail(s: SessionRow): Promise<void> {
    selected = s.id;
    clear(detailHead);
    detailHead.appendChild(h("div", { class: "row-title", text: s.display_name || s.title || s.id }));
    detailHead.appendChild(
      h("div", {
        class: "row-sub",
        text: `${s.model ?? "unknown model"} · ${s.message_count} messages · ${s.tool_call_count} tool calls · ${num(s.input_tokens)} in / ${num(s.output_tokens)} out`,
      }),
    );
    const openInChat = h(
      "button",
      { class: "btn", type: "button", style: "margin-top:10px" },
      icon("message-square", 15),
      "Continue in Chat",
    );
    openInChat.addEventListener("click", () => {
      window.location.hash = `#/chat/${encodeURIComponent(s.id)}`;
    });
    detailHead.appendChild(openInChat);

    clear(detailBody);
    detailBody.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const detail = await api.session(s.id);
      clear(detailBody);
      const msgs = detail.messages.filter((m) => (m.content ?? "").trim().length > 0);
      if (msgs.length === 0) {
        detailBody.appendChild(
          emptyState(
            "No readable messages",
            "This session has no stored message content. It may have been compacted or pruned.",
          ),
        );
        return;
      }
      for (const m of msgs) detailBody.appendChild(messageEl(m));
    } catch (err) {
      clear(detailBody);
      detailBody.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          h("p", { text: `Could not read this conversation: ${err instanceof Error ? err.message : String(err)}` }),
        ),
      );
    }
  }

  function paint(): void {
    const q = query.trim().toLowerCase();
    const rows = q
      ? all.filter((s) =>
          `${s.display_name ?? ""} ${s.title ?? ""} ${s.id} ${s.model ?? ""} ${s.source ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : all;

    countLine.textContent = q ? `${rows.length} of ${all.length}` : `${all.length} conversations`;

    clear(listRows);
    if (rows.length === 0) {
      listRows.appendChild(
        h(
          "div",
          { class: "row row-static" },
          h(
            "div",
            { class: "row-main" },
            h("div", { class: "row-sub", text: q ? `Nothing matches "${query.trim()}".` : "No conversations stored yet." }),
          ),
        ),
      );
      return;
    }
    for (const s of rows) {
      const row = h("button", {
        class: "row",
        type: "button",
        "aria-current": selected === s.id ? "true" : "false",
      });
      const main = h("div", { class: "row-main" });
      main.appendChild(h("div", { class: "row-title", text: s.display_name || s.title || s.id }));
      main.appendChild(
        h("div", {
          class: "row-sub",
          text: `${s.message_count} msgs · ${relTime(s.last_activity_at ?? s.started_at)}`,
        }),
      );
      row.appendChild(main);
      row.appendChild(h("div", { class: "row-meta", text: s.source ?? "" }));
      row.addEventListener("click", () => void openDetail(s));
      listRows.appendChild(row);
    }
  }

  const box = createAsyncBox();
  root.appendChild(box.el);

  async function load(): Promise<void> {
    clear(box.el);
    box.el.appendChild(h("div", { class: "skeleton skel-row" }));
    try {
      const data = await api.sessions({ limit: 300 });
      all = data.sessions;
      clear(box.el);
      paint();
      if (selected) {
        const found = all.find((s) => s.id === selected);
        if (found) void openDetail(found);
        else placeholder();
      } else {
        placeholder();
      }
    } catch (err) {
      clear(box.el);
      const message = err instanceof Error ? err.message : String(err);
      box.el.appendChild(
        h(
          "div",
          { class: "state state-error", role: "alert" },
          icon("triangle-alert", 28),
          h("h3", { text: "Could not load conversations" }),
          h("p", { text: message }),
          h("button", { class: "btn", type: "button", onclick: () => void load() }, "Try again"),
        ),
      );
    }
  }

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    paint();
  });

  void load();
  return root;
}
