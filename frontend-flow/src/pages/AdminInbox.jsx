import { useState, useEffect, useCallback, useRef } from "react";
import { useOutletContext } from "react-router-dom";
import Topbar from "../components/TopBar";
import {
  getAdminInboxConversations,
  getAdminInboxMessages,
  sendAdminInboxReply,
  updateAdminInboxConversation,
} from "../api/client";

const STATUS_META = {
  open:         { label: "Open",         color: "#22d3a4" },
  needs_human:  { label: "Needs reply",  color: "#f59e0b" },
  closed:       { label: "Closed",       color: "var(--text3)" },
};

const fmtTime = (d) => {
  const date = new Date(d);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-KE", { day: "numeric", month: "short" });
};

export default function AdminInbox() {
  const { openSidebar } = useOutletContext();
  const [conversations, setConversations] = useState([]);
  const [filter, setFilter] = useState("all");
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const threadEndRef = useRef(null);

  const loadConversations = useCallback(async () => {
    try {
      const data = await getAdminInboxConversations(filter === "all" ? undefined : filter);
      setConversations(data);
    } catch (e) {
      setError(e.response?.data?.message || "Could not load conversations.");
    } finally {
      setLoadingList(false);
    }
  }, [filter]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Light polling so new inbound messages show up without a manual refresh.
  useEffect(() => {
    const id = setInterval(loadConversations, 15000);
    return () => clearInterval(id);
  }, [loadConversations]);

  const openThread = async (id) => {
    setActiveId(id);
    setLoadingThread(true);
    try {
      const data = await getAdminInboxMessages(id);
      setMessages(data);
    } catch (e) {
      setError(e.response?.data?.message || "Could not load conversation.");
    } finally {
      setLoadingThread(false);
    }
  };

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!draft.trim() || !activeId) return;
    setSending(true);
    try {
      const msg = await sendAdminInboxReply(activeId, draft.trim());
      setMessages((prev) => [...prev, msg]);
      setDraft("");
      loadConversations();
    } catch (e) {
      setError(e.response?.data?.message || "Could not send reply.");
    } finally {
      setSending(false);
    }
  };

  const toggleAi = async (conv) => {
    try {
      await updateAdminInboxConversation(conv.id, { aiEnabled: !conv.aiEnabled });
      loadConversations();
    } catch (e) {
      setError(e.response?.data?.message || "Could not update conversation.");
    }
  };

  const markClosed = async () => {
    if (!activeId) return;
    try {
      await updateAdminInboxConversation(activeId, { status: "closed" });
      loadConversations();
    } catch (e) {
      setError(e.response?.data?.message || "Could not update conversation.");
    }
  };

  const activeConv = conversations.find((c) => c.id === activeId);

  return (
    <>
      <Topbar title="Inbox" sub={`${conversations.length} conversations`} onMenuClick={openSidebar} />

      {error && (
        <div style={{ margin: "0 24px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 10, padding: "10px 14px", color: "#ef4444", fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", height: "calc(100vh - 64px)", borderTop: "1px solid var(--border)" }}>
        {/* Conversation list */}
        <div style={{ width: 320, flexShrink: 0, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 6, padding: 12, borderBottom: "1px solid var(--border)" }}>
            {["all", "needs_human", "open", "closed"].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 8, cursor: "pointer",
                  border: "1px solid var(--border)", fontFamily: "inherit",
                  background: filter === f ? "var(--surface2)" : "transparent",
                  color: filter === f ? "var(--text)" : "var(--text3)",
                }}
              >
                {f === "all" ? "All" : STATUS_META[f]?.label || f}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {loadingList && <div style={{ padding: 20, fontSize: 13, color: "var(--text3)", textAlign: "center" }}>Loading…</div>}
            {!loadingList && conversations.length === 0 && (
              <div style={{ padding: 20, fontSize: 13, color: "var(--text3)", textAlign: "center" }}>No conversations yet.</div>
            )}
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => openThread(c.id)}
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "12px 14px",
                  border: "none", borderBottom: "1px solid var(--border)", cursor: "pointer",
                  background: activeId === c.id ? "var(--surface2)" : "transparent", fontFamily: "inherit",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                    {c.studentName || c.parentPhone}
                  </span>
                  <span style={{ fontSize: 10, color: STATUS_META[c.status]?.color || "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>
                    {STATUS_META[c.status]?.label || c.status}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 3 }}>
                  {c.schoolName || "Unmatched sender"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.lastMessage || "—"}
                </div>
                <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 3 }}>{fmtTime(c.lastMessageAt)}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Thread */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {!activeId && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontSize: 13 }}>
              Select a conversation
            </div>
          )}

          {activeId && (
            <>
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{activeConv?.studentName || activeConv?.parentPhone}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)" }}>{activeConv?.schoolName || "Unmatched sender"} · {activeConv?.parentPhone}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={() => activeConv && toggleAi(activeConv)}
                    style={{
                      fontSize: 12, fontWeight: 600, padding: "6px 10px", borderRadius: 8, cursor: "pointer",
                      border: "1px solid var(--border)", fontFamily: "inherit",
                      background: activeConv?.aiEnabled ? "rgba(34,211,164,0.1)" : "var(--surface2)",
                      color: activeConv?.aiEnabled ? "#22d3a4" : "var(--text3)",
                    }}
                  >
                    AI {activeConv?.aiEnabled ? "on" : "off"}
                  </button>
                  <button
                    onClick={markClosed}
                    style={{ fontSize: 12, fontWeight: 600, padding: "6px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text3)", fontFamily: "inherit" }}
                  >
                    Close
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
                {loadingThread && <div style={{ fontSize: 13, color: "var(--text3)", textAlign: "center" }}>Loading…</div>}
                {!loadingThread && messages.map((m) => (
                  <div key={m.id} style={{ display: "flex", justifyContent: m.direction === "inbound" ? "flex-start" : "flex-end" }}>
                    <div style={{
                      maxWidth: "70%", padding: "9px 13px", borderRadius: 14, fontSize: 13, lineHeight: 1.5,
                      background: m.direction === "inbound" ? "var(--surface2)" : "rgba(34,211,164,0.12)",
                      border: `1px solid ${m.direction === "inbound" ? "var(--border)" : "rgba(34,211,164,0.25)"}`,
                    }}>
                      <div>{m.body}</div>
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 4, display: "flex", gap: 6 }}>
                        {m.direction === "outbound" && <span style={{ textTransform: "capitalize" }}>{m.sender}</span>}
                        <span>{fmtTime(m.createdAt)}</span>
                        {m.status === "failed" && <span style={{ color: "#ef4444" }}>Failed to send</span>}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={threadEndRef} />
              </div>

              <div style={{ padding: 14, borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !sending && handleSend()}
                  placeholder="Type a reply…"
                  style={{ flex: 1, padding: "10px 14px", borderRadius: 10, fontSize: 13, background: "var(--surface2)", border: "1px solid var(--border)", color: "var(--text)", outline: "none", fontFamily: "inherit" }}
                />
                <button
                  onClick={handleSend}
                  disabled={sending || !draft.trim()}
                  className="btn btn-primary"
                  style={{ padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 700, opacity: sending || !draft.trim() ? 0.5 : 1 }}
                >
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
