import { useNavigate } from "react-router-dom";
import { S } from "../styles";

/**
 * Entry/landing page. Three roles: Player, Organizer, Judge.
 * Judge is the currently-fully-built path; the other two are scaffolded
 * for future features (prereg, bracket view, manual overrides, etc.).
 */
export function LandingScreen() {
  const nav = useNavigate();

  const choices = [
    {
      to: "/judge",
      emoji: "⚔️",
      title: "I'm a Judge",
      body: "Score matches, manage the bracket, submit to Challonge",
      color: "#1D4ED8",
      ready: true,
    },
    {
      to: "/organizer",
      emoji: "🎛️",
      title: "I'm an Organizer",
      body: "Create tournaments, manage PINs, review match results",
      color: "#7C3AED",
      ready: false,
    },
    {
      to: "/player",
      emoji: "🎯",
      title: "I'm a Player",
      body: "View the bracket, check standings, pre-register combos",
      color: "#EA580C",
      ready: false,
    },
  ];

  return (
    <div style={{ ...S.current.page, height: "100dvh", overflowY: "auto", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>⚔️</div>
        <h1 style={S.current.logo}>
          NC <span style={{ color: "#EA580C" }}>BLAST</span>
        </h1>
        <p style={S.current.sub}>NorCal Battle Log and Stat Tracker</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {choices.map(c => (
          <button
            key={c.to}
            onClick={() => nav(c.to)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              width: "100%",
              padding: "18px 20px",
              borderRadius: 14,
              border: `2px solid ${c.color}40`,
              background: `${c.color}0D`,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "'Outfit', sans-serif",
              position: "relative",
            }}
          >
            <span style={{ fontSize: 36 }}>{c.emoji}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: c.color, marginBottom: 2 }}>
                {c.title}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.4 }}>
                {c.body}
              </div>
            </div>
            {!c.ready && (
              <span style={{
                position: "absolute",
                top: 8,
                right: 10,
                fontSize: 9,
                fontWeight: 800,
                color: "#A16207",
                background: "#FEF3C7",
                border: "1px solid #FDE68A",
                borderRadius: 10,
                padding: "2px 7px",
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}>
                Coming soon
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
