"use client";

import { useState } from "react";
import Aurora from "./Aurora";
import Landing from "./Landing";
import Rail from "./Rail";
import Chat from "./Chat";

export default function App() {
  const [started, setStarted] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>();

  return (
    <>
      <Aurora />
      {!started ? (
        <Landing onStart={(p) => { setInitialPrompt(p); setStarted(true); }} />
      ) : (
        <div className="shell">
          <Rail />
          <main className="main">
            <Chat initialPrompt={initialPrompt} />
          </main>
        </div>
      )}
    </>
  );
}
