import "dotenv/config";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { MongoClient, ObjectId } from "mongodb";

const PORT = process.env.PORT || 3000;
const HOST = "127.0.0.1";
const ROOT = process.cwd();

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "onehub";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "1500607972605296713";

const DATA_FILE = join(ROOT, "data.json");
const mongoClient = new MongoClient(MONGO_URI || "mongodb://localhost:27017");
let mongoDb = null;
const USE_JSON_FALLBACK = !MONGO_URI;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(pw, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const derived = pbkdf2Sync(pw, salt, 120000, 32, "sha256");
  const storedBuf = Buffer.from(hash, "hex");
  if (derived.length !== storedBuf.length) return false;
  return timingSafeEqual(derived, storedBuf);
}

async function getDb() {
  if (mongoDb) return mongoDb;
  if (!MONGO_URI) return null;
  try {
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);
    return mongoDb;
  } catch {
    return null;
  }
}

async function readDataFile() {
  try {
    if (!existsSync(DATA_FILE)) {
      await writeDataFile({ users: [], products: [], members: [], settings: {} });
      return { users: [], products: [], members: [], settings: {} };
    }
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { users: [], products: [], members: [], settings: {} };
  }
}

async function writeDataFile(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function createLocalId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getLocalDiscordBotToken() {
  if (DISCORD_BOT_TOKEN) return DISCORD_BOT_TOKEN;
  const data = existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) : {};
  return data.settings?.discordBotToken || null;
}

function normalizeProduct(p) {
  return {
    id: p._id?.toString?.() || p.id,
    name: p.name || "",
    description: p.description || "",
    price: p.price || 0,
    image: p.image || "",
    category: p.category || "",
    stock: p.stock ?? 0,
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || new Date().toISOString(),
  };
}

function normalizeDiscordMember(m) {
  return {
    id: m.user?.id || m.id || "",
    username: m.user?.username || m.username || "",
    displayName: m.nick || m.user?.global_name || m.user?.username || "",
    avatar: m.user?.avatar
      ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
      : "",
    roles: m.roles || [],
    joinedAt: m.joined_at || null,
  };
}

function normalizeUser(u) {
  return {
    id: u._id?.toString?.() || u.id,
    username: u.username || "",
    password: u.password || "",
    role: u.role || "user",
    createdAt: u.createdAt || new Date().toISOString(),
  };
}

async function handleApi(req, res, url, method) {
  if (method === "OPTIONS") {
    sendJson(res, 204, null);
    return true;
  }

  if (url === "/api/discord/roles" && method === "GET") {
    try {
      const token = getLocalDiscordBotToken();
      if (!token) return sendJson(res, 400, { error: "Discord bot token not configured" });
      const resp = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/roles`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!resp.ok) return sendJson(res, resp.status, { error: "Failed to fetch roles" });
      let roles = await resp.json();
      roles = roles
        .filter((r) => r.name !== "@everyone")
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }));
      return sendJson(res, 200, roles);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url === "/api/discord/channels" && method === "GET") {
    try {
      const token = getLocalDiscordBotToken();
      if (!token) return sendJson(res, 400, { error: "Discord bot token not configured" });
      const resp = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/channels`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!resp.ok) return sendJson(res, resp.status, { error: "Failed to fetch channels" });
      let channels = await resp.json();
      channels = channels
        .filter((c) => c.type === 0)
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id }));
      return sendJson(res, 200, channels);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url === "/api/users" && method === "POST") {
    try {
      const body = await readJson(req);
      const { action, username, password } = body;
      if (!username || !password) return sendJson(res, 400, { error: "Username and password required" });

      if (action === "signup") {
        if (USE_JSON_FALLBACK) {
          const data = await readDataFile();
          if (data.users.find((u) => u.username === username)) {
            return sendJson(res, 409, { error: "User already exists" });
          }
          const user = {
            id: createLocalId(),
            username,
            password: hashPassword(password),
            role: "user",
            createdAt: new Date().toISOString(),
          };
          data.users.push(user);
          await writeDataFile(data);
          return sendJson(res, 201, { success: true, user: normalizeUser(user) });
        } else {
          const db = await getDb();
          if (!db) return sendJson(res, 500, { error: "Database unavailable" });
          const existing = await db.collection("users").findOne({ username });
          if (existing) return sendJson(res, 409, { error: "User already exists" });
          const user = {
            username,
            password: hashPassword(password),
            role: "user",
            createdAt: new Date().toISOString(),
          };
          const result = await db.collection("users").insertOne(user);
          user._id = result.insertedId;
          return sendJson(res, 201, { success: true, user: normalizeUser(user) });
        }
      }

      if (action === "login") {
        let found;
        if (USE_JSON_FALLBACK) {
          const data = await readDataFile();
          found = data.users.find((u) => u.username === username);
        } else {
          const db = await getDb();
          if (!db) return sendJson(res, 500, { error: "Database unavailable" });
          found = await db.collection("users").findOne({ username });
        }
        if (!found) return sendJson(res, 401, { error: "Invalid credentials" });
        if (!verifyPassword(password, found.password)) {
          return sendJson(res, 401, { error: "Invalid credentials" });
        }
        return sendJson(res, 200, { success: true, user: normalizeUser(found) });
      }

      return sendJson(res, 400, { error: "Invalid action. Use 'signup' or 'login'" });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url === "/api/discord-token" && method === "POST") {
    try {
      const body = await readJson(req);
      if (!body.discordBotToken) return sendJson(res, 400, { error: "discordBotToken required" });
      const data = await readDataFile();
      data.settings = data.settings || {};
      data.settings.discordBotToken = body.discordBotToken;
      await writeDataFile(data);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url === "/api/bot/status" && method === "GET") {
    try {
      const token = getLocalDiscordBotToken();
      if (!token) return sendJson(res, 400, { error: "Discord bot token not configured" });
      const resp = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!resp.ok) return sendJson(res, 200, { online: false });
      const user = await resp.json();
      return sendJson(res, 200, { online: true, username: user.username, id: user.id });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (url === "/api/bot/sync" && method === "POST") {
    try {
      const token = getLocalDiscordBotToken();
      if (!token) return sendJson(res, 400, { error: "Discord bot token not configured" });
      const [botResp, guildsResp] = await Promise.all([
        fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bot ${token}` },
        }),
        fetch(`https://discord.com/api/v10/users/@me/guilds`, {
          headers: { Authorization: `Bot ${token}` },
        }),
      ]);
      if (!botResp.ok || !guildsResp.ok) {
        return sendJson(res, 400, { error: "Failed to sync bot info" });
      }
      const botUser = await botResp.json();
      const guilds = await guildsResp.json();
      const data = await readDataFile();
      data.settings = data.settings || {};
      data.settings.botInfo = {
        id: botUser.id,
        username: botUser.username,
        discriminator: botUser.discriminator,
        avatar: botUser.avatar
          ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
          : null,
        guilds: guilds.map((g) => ({ id: g.id, name: g.name })),
        lastSync: new Date().toISOString(),
      };
      await writeDataFile(data);
      return sendJson(res, 200, { success: true, bot: data.settings.botInfo });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  return false;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function syncBotOnStartup() {
  try {
    const token = getLocalDiscordBotToken();
    if (!token) return;
    const [botResp, guildsResp] = await Promise.all([
      fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      }),
      fetch("https://discord.com/api/v10/users/@me/guilds", {
        headers: { Authorization: `Bot ${token}` },
      }),
    ]);
    if (!botResp.ok || !guildsResp.ok) return;
    const botUser = await botResp.json();
    const guilds = await guildsResp.json();
    const data = await readDataFile();
    data.settings = data.settings || {};
    data.settings.botInfo = {
      id: botUser.id,
      username: botUser.username,
      discriminator: botUser.discriminator,
      avatar: botUser.avatar
        ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
        : null,
      guilds: guilds.map((g) => ({ id: g.id, name: g.name })),
      lastSync: new Date().toISOString(),
    };
    await writeDataFile(data);
  } catch {
    // silently fail on startup
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname.startsWith("/api/")) {
    const handled = await handleApi(req, res, pathname, method);
    if (handled) return;
    sendJson(res, 404, { error: "API route not found" });
    return;
  }

  let filePath = join(ROOT, normalize(pathname));
  if (filePath === join(ROOT, "/") || pathname === "/") {
    filePath = join(ROOT, "index.html");
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = join(filePath, "index.html");
      await fs.stat(filePath);
    }
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end("404 Not Found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ONE HUB rodando em http://${HOST}:${PORT}`);
  syncBotOnStartup();
});
