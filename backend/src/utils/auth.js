// utils/auth.js
const jwt = require("jsonwebtoken");

// tiny cookie parser fallback (in case cookie-parser isn't mounted)
function parseCookieHeader(header = "") {
  return header.split(/;\s*/).reduce((acc, part) => {
    const i = part.indexOf("=");
    if (i > -1) acc[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
    return acc;
  }, {});
}

function decodeJwtFromReq(req) {
  try {
    // 1) Try cookie-parser (req.cookies)
    let token = req.cookies?.shega_token;

    // 2) Fallback: raw header
    if (!token && req.headers?.cookie) {
      const parsed = parseCookieHeader(req.headers.cookie);
      token = parsed.shega_token;
    }

    if (!token) {
      console.warn("[auth] No shega_token cookie found");
      return null;
    }

    if (!process.env.JWT_SECRET) {
      console.error("[auth] JWT_SECRET is missing in env");
      return null;
    }

    // 3) Verify + decode
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // 4) Normalize to  app shape (houseId = first home)
    const houseId = Array.isArray(payload.homes) ? payload.homes[0] : payload.houseId;
    const user = {
      userId: payload.userId || payload.sub,
      role: payload.role,
      email: payload.email,
      houseId,
      raw: payload, // keep raw for debugging if you like
    };

    return user;
  } catch (err) {
    console.warn("[auth] JWT verify failed:", err.message);
    return null;
  }
}

module.exports = { decodeJwtFromReq };
