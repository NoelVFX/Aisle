"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Sparkle, User } from "@phosphor-icons/react";
import type { AgentRequest, AgentResponse, Message } from "@/lib/types";
import { BlockView, Shimmer, type Sender } from "./blocks";

const INTRO: Message = {
  id: "intro",
  role: "aisle",
  blocks: [
    { type: "text", text: "I am **Aisle**, your commerce agent. Tell me what to buy and I will discover it, price it, and get one approval before anything is charged. Physical goods go through Agnic's checkout rail, software and credits through the vendor's own checkout. Try a shortcut below." },
  ],
};

const SUGGESTIONS = ["Show me a blazer", "Find me a keyboard", "Set up my profile", "I need an MCP tool that sends email", "My For You"];

function actionPhrase(payload: { text?: string; action?: AgentRequest["action"] }): string {
  if (payload.text) return payload.text;
  const a = payload.action;
  if (!a) return "";
  if (a.kind === "pick") return `I'll take the ${a.product.title}.`;
  if (a.kind === "approve") return "Approve and buy.";
  if (a.kind === "saveProfile") return "Here is my profile.";
  if (a.kind === "forYou") return "Show my For You.";
  if (a.kind === "browse") return a.query ?? "Browse.";
  return "";
}

export default function Chat({ initialPrompt }: { initialPrompt?: string }) {
  const [messages, setMessages] = useState<Message[]>([INTRO]);
  const [busy, setBusy] = useState<null | "chat" | "shortlist">(null);
  const [input, setInput] = useState("");
  const stateRef = useRef({ purchasedSkus: [] as string[], purchasedTitles: [] as string[], profileTags: [] as string[] });
  const streamRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sentInitial = useRef(false);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send: Sender = useCallback((payload) => {
    if (busy) return;
    const phrase = actionPhrase(payload);
    const userMsg: Message = { id: "u" + Date.now(), role: "user", blocks: [{ type: "text", text: phrase }] };
    const likelyList =
      payload.action?.kind === "forYou" ||
      payload.action?.kind === "browse" ||
      (!!payload.text && /blazer|keyboard|desk|show me|find me|for you|recommend/i.test(payload.text));
    // Plain-text transcript so the LLM branch has conversation context.
    const history = messages.slice(-10).map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.blocks.map((b) => (b.type === "text" ? b.text : `[${b.type === "shortlist" ? "showed options" : b.type}]`)).join(" ").slice(0, 600),
    }));
    setMessages((m) => [...m, userMsg]);
    setBusy(likelyList ? "shortlist" : "chat");

    const req: AgentRequest = { ...payload, history, state: { ...stateRef.current } } as AgentRequest;
    fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) })
      .then((r) => r.json() as Promise<AgentResponse>)
      .then((res) => {
        if (res.purchasedSku) stateRef.current.purchasedSkus = [...stateRef.current.purchasedSkus, res.purchasedSku];
        if (res.purchasedTitle) stateRef.current.purchasedTitles = [...stateRef.current.purchasedTitles, res.purchasedTitle];
        if (res.profileTags) stateRef.current.profileTags = res.profileTags;
        setMessages((m) => [...m, { id: "a" + Date.now(), role: "aisle", blocks: res.blocks }]);
      })
      .catch(() => setMessages((m) => [...m, { id: "e" + Date.now(), role: "aisle", blocks: [{ type: "text", text: "Something went wrong reaching the agent. Try again in a moment." }] }]))
      .finally(() => setBusy(null));
  }, [busy]);

  // Auto-send the prompt the user typed on the landing screen, exactly once.
  useEffect(() => {
    if (initialPrompt && !sentInitial.current) { sentInitial.current = true; send({ text: initialPrompt }); }
  }, [initialPrompt, send]);

  const submit = () => {
    const t = input.trim();
    if (!t || busy) return;
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    send({ text: t });
  };

  return (
    <>
      <div className="chat-head">
        <div style={{ fontWeight: 560, letterSpacing: "-0.01em" }}>Aisle</div>
        <div className="status"><span className="pulse" /> Demo mode</div>
      </div>

      <div className="stream" ref={streamRef}>
        <div className="stream-inner">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role === "user" ? "user" : "aisle"}`}>
              <div className="msg-avatar">{m.role === "user" ? <User size={15} weight="bold" /> : <Sparkle size={16} weight="fill" />}</div>
              <div className="msg-body">
                {m.role === "user"
                  ? <div className="bubble-user">{m.blocks[0]?.type === "text" ? m.blocks[0].text : ""}</div>
                  : m.blocks.map((b, i) => <BlockView key={i} block={b} send={send} />)}
              </div>
            </div>
          ))}

          {busy ? (
            <div className="msg aisle">
              <div className="msg-avatar"><Sparkle size={16} weight="fill" /></div>
              <div className="msg-body">
                {busy === "shortlist"
                  ? <Shimmer />
                  : <div className="typing"><i /><i /><i /></div>}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <div className="suggests">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="suggest" disabled={!!busy} onClick={() => send(s === "My For You" ? { action: { kind: "forYou" } } : { text: s })}>{s}</button>
            ))}
          </div>
          <div className="composer-box">
            <textarea
              ref={taRef}
              className="composer-input"
              rows={1}
              placeholder="Ask Aisle to buy something, or find a tool for a goal…"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            />
            <button className="send" onClick={submit} disabled={!input.trim() || !!busy} aria-label="Send">
              <ArrowUp size={18} weight="bold" />
            </button>
          </div>
          <div className="foot-note">Aisle never types your card. One approval, then a real checkout. Demo data shown here.</div>
        </div>
      </div>
    </>
  );
}
