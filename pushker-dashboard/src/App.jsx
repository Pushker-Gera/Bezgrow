import { useState, useEffect } from "react";

/*
=================================================
PUSHKER 2.0 – COMMANDER MODE ELITE DASHBOARD
=================================================
Extreme Features:
- 14 Day Maths War Plan (24 Lecture Target)
- Dynamic Daily Timetable Timeline View
- AI Commander Mode (Performance Based Messaging)
- Streak Tracking
- Progress Engine
- Curiosity Trigger System
- Weight Tracking
- Auto Save
*/

const TOTAL_MATHS_TARGET = 24;
const WAR_DAYS = 14;

const timetable = [
  { time: "8:30 AM", task: "Wake Up – No Phone" },
  { time: "9:30–12:00", task: "Lecture 1 + Full Solving" },
  { time: "12:45–2:45", task: "Lecture 2 + Full Solving" },
  { time: "3:30–4:30", task: "DPP Practice + Error Analysis" },
  { time: "5:30–8:30", task: "Badminton + Travel" },
  { time: "9:30–10:30", task: "Revision + Weak Areas" },
  { time: "1:00 AM", task: "Sleep – Recovery Mode" },
];

export default function App() {
  const [completedLectures, setCompletedLectures] = useState(
    Number(localStorage.getItem("completedLectures")) || 0
  );
  const [currentDay, setCurrentDay] = useState(
    Number(localStorage.getItem("currentDay")) || 1
  );
  const [streak, setStreak] = useState(
    Number(localStorage.getItem("pushkerStreak")) || 0
  );
  const [weight, setWeight] = useState(
    localStorage.getItem("pushkerWeight") || ""
  );
  const [todayLectures, setTodayLectures] = useState(0);

  useEffect(() => {
    localStorage.setItem("completedLectures", completedLectures);
    localStorage.setItem("currentDay", currentDay);
    localStorage.setItem("pushkerStreak", streak);
    localStorage.setItem("pushkerWeight", weight);
  }, [completedLectures, currentDay, streak, weight]);

  const lecturesRemaining = TOTAL_MATHS_TARGET - completedLectures;
  const todayTarget = Math.ceil(TOTAL_MATHS_TARGET / WAR_DAYS);
  const progressPercent = Math.round(
    (completedLectures / TOTAL_MATHS_TARGET) * 100
  );

  const completeLecture = () => {
    if (completedLectures < TOTAL_MATHS_TARGET) {
      setCompletedLectures((prev) => prev + 1);
      setTodayLectures((prev) => prev + 1);
    }
  };

  const completeDay = () => {
    if (todayLectures >= todayTarget) {
      setStreak((prev) => prev + 1);
      if (currentDay < WAR_DAYS) setCurrentDay((prev) => prev + 1);
      setTodayLectures(0);
    }
  };

  const resetAll = () => {
    setCompletedLectures(0);
    setCurrentDay(1);
    setStreak(0);
    setTodayLectures(0);
  };

  // ============================
  // AI COMMANDER MODE ENGINE
  // ============================

  const commanderMessage = () => {
    if (progressPercent >= 100)
      return "MISSION COMPLETE. You operated at elite level.";

    if (todayLectures === 0)
      return "Commander: You haven't executed yet. Start now.";

    if (todayLectures < todayTarget)
      return "Commander: You are mid‑mission. Stay locked in.";

    if (todayLectures >= todayTarget)
      return "Commander: Target achieved. Maintain discipline.";

    if (streak >= 5)
      return "Commander: Momentum detected. Do not break chain.";

    return "Commander: Execute without emotion.";
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0f172a",
        color: "white",
        padding: "30px",
        fontFamily: "Arial",
      }}
    >
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>
        <h1 style={{ textAlign: "center" }}>
          PUSHKER 2.0 – COMMANDER MODE
        </h1>

        {/* Mission Panel */}
        <section style={cardStyle}>
          <h2>🔥 Current Mission</h2>
          <p>Day {currentDay} / {WAR_DAYS}</p>
          <p>Today Target: {todayTarget} Lectures</p>
          <p>Total Progress: {completedLectures}/{TOTAL_MATHS_TARGET}</p>
          <p>Remaining: {lecturesRemaining}</p>
          <p>Completion: {progressPercent}%</p>
        </section>

        {/* AI Commander */}
        <section style={{ ...cardStyle, background: "#111827" }}>
          <h2>🧠 AI Commander</h2>
          <p style={{ fontWeight: "bold" }}>{commanderMessage()}</p>
        </section>

        {/* Daily Timetable */}
        <section style={cardStyle}>
          <h2>📅 Daily Timeline</h2>
          {timetable.map((item, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: "1px solid #334155",
              }}
            >
              <span>{item.time}</span>
              <span>{item.task}</span>
            </div>
          ))}
        </section>

        {/* Controls */}
        <section style={{ marginTop: "20px" }}>
          <button onClick={completeLecture} style={btn("#2563eb")}>
            + Complete Lecture
          </button>
          <button onClick={completeDay} style={btn("#16a34a")}>
            Mark Day Complete
          </button>
        </section>

        {/* Performance */}
        <section style={cardStyle}>
          <h2>📈 Performance Stats</h2>
          <p>Streak: {streak} Days</p>
          <p>Today's Lectures Done: {todayLectures}</p>
        </section>

        {/* Weight */}
        <section style={{ marginTop: "20px" }}>
          <h3>⚖ Weight (kg)</h3>
          <input
            type="number"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            style={{
              width: "100%",
              padding: "10px",
              borderRadius: "10px",
            }}
          />
        </section>

        <button
          onClick={resetAll}
          style={{
            marginTop: "30px",
            width: "100%",
            padding: "12px",
            borderRadius: "10px",
            border: "none",
            background: "#dc2626",
            color: "white",
            cursor: "pointer",
          }}
        >
          RESET FULL SYSTEM
        </button>
      </div>
    </div>
  );
}

const cardStyle = {
  background: "#1e293b",
  padding: "20px",
  borderRadius: "15px",
  marginTop: "20px",
};

const btn = (color) => ({
  width: "100%",
  padding: "12px",
  marginTop: "10px",
  borderRadius: "10px",
  border: "none",
  background: color,
  color: "white",
  cursor: "pointer",
});