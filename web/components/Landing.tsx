"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "@phosphor-icons/react";

const NAME = "Anson";
const EXAMPLES = [
  "a mechanical keyboard under $130",
  "an MCP tool that sends email autonomously",
  "a navy wool blazer, smart-casual",
  "top up 100 credits on higgsfield",
  "the best hosted search for my app",
];
const CHIPS = ["A mechanical keyboard", "An email-sending MCP tool", "A navy wool blazer"];

export default function Landing({ onStart }: { onStart: (prompt: string) => void }) {
  const [value, setValue] = useState("");
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Typewriter: type an example, hold, delete, move to the next. Pauses while the user types.
  useEffect(() => {
    if (value) return; // don't run the placeholder animation while there's real input
    let i = 0, char = 0, deleting = false, timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const word = EXAMPLES[i % EXAMPLES.length];
      if (!deleting) {
        char++;
        setTyped(word.slice(0, char));
        if (char === word.length) { deleting = true; timer = setTimeout(tick, 1500); return; }
        timer = setTimeout(tick, 52 + Math.random() * 40);
      } else {
        char--;
        setTyped(word.slice(0, char));
        if (char === 0) { deleting = false; i++; timer = setTimeout(tick, 320); return; }
        timer = setTimeout(tick, 26);
      }
    };
    timer = setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, [value]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = (text?: string) => {
    const p = (text ?? value).trim();
    if (p) onStart(p);
  };

  return (
    <div className="landing">
      <div className="landing-brand">
        <div className="brand-mark">A</div>
        <div>
          <div className="brand-name">Aisle</div>
          <div className="brand-sub">Agentic Checkout</div>
        </div>
      </div>

      <div className="landing-inner">
        <h1 className="greeting">Hi {NAME}, what do you want to <span className="accent">buy</span> today?</h1>
        <p className="landing-sub">One prompt. Aisle finds it, prices it, and gets your one approval before anything is charged.</p>

        <div className="prompt-wrap">
          <div className="prompt-box">
            <div className="prompt-field">
              <input
                ref={inputRef}
                className="prompt-input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
                aria-label="What do you want to buy?"
              />
              {value === "" && (
                <div className="typewriter" aria-hidden>
                  <span>{typed}</span>
                  <span className="caret" />
                </div>
              )}
            </div>
            <button className="prompt-send" onClick={() => submit()} disabled={!value.trim()} aria-label="Start">
              <ArrowUp size={20} weight="bold" />
            </button>
          </div>

          <div className="landing-chips">
            {CHIPS.map((c) => (
              <button key={c} className="landing-chip" onClick={() => submit(c)}>{c}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
