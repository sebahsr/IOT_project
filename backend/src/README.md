# SHEGA Backend (IoT – Air & Stove Safety)

Node.js backend for the SHEGA project. Features:

- MQTT ingest (Mosquitto) for AirNode & StoveNode
- MongoDB storage (Users, Devices, Telemetry)
- Auth (JWT), roles (admin/user), per-home scoping
- REST APIs: devices, telemetry (with CSV export), dashboard summaries
- Live updates via Socket.IO (telemetry, alerts, commands)
- Device commands → MQTT publish (fan/buzzer, etc.)
- Optional telemetry TTL (auto-expire old rows)
- Rate limits, CORS, Helmet, 404 & error handlers

## Quick Start

```bash
# 1) Install deps
npm i

# 2) Copy and edit environment
cp .env.example .env
# .env should define at least: MONGO_URI, JWT_SECRET
# Optional: TELEMETRY_TTL_DAYS=30

# 3) Seed admin (optional)
npm run seed

# 4) Run
npm run dev
