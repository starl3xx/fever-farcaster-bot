export default function Home() {
  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1>fever-farcaster-bot</h1>
      <p>
        Posts Indiana Fever WNBA recaps to the <code>/fever</code> Farcaster
        channel. See <code>/api/cron/check-games</code>.
      </p>
    </main>
  );
}
