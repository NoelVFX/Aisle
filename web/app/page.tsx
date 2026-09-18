import Rail from "@/components/Rail";
import Chat from "@/components/Chat";

export default function Page() {
  return (
    <div className="shell">
      <Rail />
      <main className="main">
        <Chat />
      </main>
    </div>
  );
}
