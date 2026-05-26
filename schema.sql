CREATE TABLE IF NOT EXISTS game_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  secret_word TEXT NOT NULL,
  player_name TEXT NOT NULL,
  question TEXT NOT NULL,
  score INTEGER NOT NULL,
  feedback TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS room_sessions (
  room_id TEXT PRIMARY KEY,
  secret_word TEXT,
  winner_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME
);
