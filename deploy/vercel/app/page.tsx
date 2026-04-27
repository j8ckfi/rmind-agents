/**
 * Home page on the Vercel side — every request is rewritten to the rack via
 * next.config.ts, so this fallback only renders if the rack is unreachable.
 */

export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>rmind-agents</h1>
      <p>The rack is currently unavailable. Try again in a moment.</p>
    </main>
  );
}
