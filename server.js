require('dotenv').config();
const fs = require('fs/promises');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { MongoClient } = require('mongodb');

const port = Number(process.env.PORT) || 3000;
const host = '127.0.0.1';
const root = process.cwd();
const mongoUri = process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME || 'turquia_hub';
const discordBotToken = process.env.DISCORD_BOT_TOKEN || '';
const discordGuildId = process.env.DISCORD_GUILD_ID || '1500607972605296713';
const dataFile = path.join(root, 'data.json');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function resolvePath(url) {
  let p = url.split('?')[0];
  if (p === '/') p = '/index.html';
  const resolved = path.normalize(path.join(root, p));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return derived === hash;
}

let mongoClient = null;

async function getDb() {
  if (!mongoUri) return null;
  try {
    if (!mongoClient) {
      mongoClient = new MongoClient(mongoUri);
      await mongoClient.connect();
    }
    return mongoClient.db(mongoDbName);
  } catch {
    return null;
  }
}

async function readDataFile() {
  try {
    const raw = await fs.readFile(dataFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { products: [], users: [], settings: {} };
  }
}

async function writeDataFile(data) {
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2), 'utf-8');
}

function createLocalId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getLocalDiscordBotToken() {
  return discordBotToken || process.env.DISCORD_BOT_TOKEN || '';
}

function normalizeProduct(product) {
  return {
    id: product._id || product.id,
    _id: product._id || product.id,
    name: product.name || '',
    description: product.description || '',
    price: product.price || 0,
    image: product.image || '',
    category: product.category || '',
    stock: product.stock ?? 0,
    isActive: product.isActive !== undefined ? product.isActive : true,
    createdAt: product.createdAt || new Date().toISOString(),
    updatedAt: product.updatedAt || new Date().toISOString(),
  };
}

function normalizeDiscordMember(member) {
  return {
    id: member.user?.id || member.id || '',
    username: member.user?.username || member.username || '',
    displayName: member.nick || member.user?.global_name || member.user?.username || member.username || '',
    avatar: member.user?.avatar
      ? `https://cdn.discordapp.com/avatars/${member.user.id}/${member.user.avatar}.png`
      : '',
    roles: member.roles || [],
    joinedAt: member.joined_at || null,
    isBot: member.user?.bot || false,
  };
}

function normalizeUser(user) {
  return {
    id: user._id || user.id,
    _id: user._id || user.id,
    username: user.username || '',
    password: user.password || '',
    discordId: user.discordId || '',
    discordUsername: user.discordUsername || '',
    avatar: user.avatar || '',
    coins: user.coins ?? 0,
    role: user.role || 'user',
    createdAt: user.createdAt || new Date().toISOString(),
    updatedAt: user.updatedAt || new Date().toISOString(),
  };
}

async function handleApi(request, response, urlPath) {
  const method = request.method;

  if (method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    });
    response.end();
    return;
  }

  try {
    // GET /api/shop-products
    if (method === 'GET' && urlPath === '/api/shop-products') {
      const db = await getDb();
      if (db) {
        const products = await db.collection('products').find({ isActive: true }).toArray();
        sendJson(response, 200, products.map(normalizeProduct));
      } else {
        const data = await readDataFile();
        sendJson(response, 200, data.products.filter(p => p.isActive !== false).map(normalizeProduct));
      }
      return;
    }

    // POST /api/shop-products
    if (method === 'POST' && urlPath === '/api/shop-products') {
      const body = await readJson(request);
      const product = normalizeProduct({ ...body, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const db = await getDb();
      if (db) {
        const result = await db.collection('products').insertOne(product);
        product._id = result.insertedId;
        product.id = result.insertedId;
        sendJson(response, 201, normalizeProduct(product));
      } else {
        const data = await readDataFile();
        const id = createLocalId();
        product._id = id;
        product.id = id;
        data.products.push(product);
        await writeDataFile(data);
        sendJson(response, 201, normalizeProduct(product));
      }
      return;
    }

    // PATCH /api/shop-products
    if (method === 'PATCH' && urlPath === '/api/shop-products') {
      const body = await readJson(request);
      const params = new URL(request.url, `http://localhost:${port}`).searchParams;
      const productId = params.get('id') || body.id || body._id;
      if (!productId) {
        sendJson(response, 400, { error: 'Product ID is required' });
        return;
      }
      const updated = { ...body, updatedAt: new Date().toISOString() };
      delete updated._id;
      delete updated.id;
      const db = await getDb();
      if (db) {
        const result = await db.collection('products').findOneAndUpdate(
          { _id: productId },
          { $set: updated },
          { returnDocument: 'after' }
        );
        if (!result) {
          sendJson(response, 404, { error: 'Product not found' });
          return;
        }
        sendJson(response, 200, normalizeProduct(result));
      } else {
        const data = await readDataFile();
        const idx = data.products.findIndex(p => (p._id === productId || p.id === productId));
        if (idx === -1) {
          sendJson(response, 404, { error: 'Product not found' });
          return;
        }
        Object.assign(data.products[idx], updated);
        await writeDataFile(data);
        sendJson(response, 200, normalizeProduct(data.products[idx]));
      }
      return;
    }

    // DELETE /api/shop-products
    if (method === 'DELETE' && urlPath === '/api/shop-products') {
      const params = new URL(request.url, `http://localhost:${port}`).searchParams;
      const productId = params.get('id');
      if (!productId) {
        sendJson(response, 400, { error: 'Product ID is required' });
        return;
      }
      const db = await getDb();
      if (db) {
        await db.collection('products').findOneAndUpdate(
          { _id: productId },
          { $set: { isActive: false, updatedAt: new Date().toISOString() } }
        );
        sendJson(response, 200, { success: true });
      } else {
        const data = await readDataFile();
        const idx = data.products.findIndex(p => (p._id === productId || p.id === productId));
        if (idx !== -1) {
          data.products[idx].isActive = false;
          data.products[idx].updatedAt = new Date().toISOString();
          await writeDataFile(data);
        }
        sendJson(response, 200, { success: true });
      }
      return;
    }

    // GET /api/users
    if (method === 'GET' && urlPath === '/api/users') {
      const db = await getDb();
      if (db) {
        const users = await db.collection('users').find().toArray();
        sendJson(response, 200, users.map(normalizeUser));
      } else {
        const data = await readDataFile();
        sendJson(response, 200, data.users.map(normalizeUser));
      }
      return;
    }

    // POST /api/users
    if (method === 'POST' && urlPath === '/api/users') {
      const body = await readJson(request);
      const { action } = body;

      if (action === 'login') {
        const { username, password } = body;
        const db = await getDb();
        if (db) {
          const user = await db.collection('users').findOne({ username });
          if (!user || !verifyPassword(password, user.password)) {
            sendJson(response, 401, { error: 'Invalid credentials' });
            return;
          }
          sendJson(response, 200, normalizeUser(user));
        } else {
          const data = await readDataFile();
          const user = data.users.find(u => u.username === username);
          if (!user || !verifyPassword(password, user.password)) {
            sendJson(response, 401, { error: 'Invalid credentials' });
            return;
          }
          sendJson(response, 200, normalizeUser(user));
        }
        return;
      }

      if (action === 'signup') {
        const { username, password } = body;
        if (!username || !password) {
          sendJson(response, 400, { error: 'Username and password required' });
          return;
        }
        const db = await getDb();
        if (db) {
          const existing = await db.collection('users').findOne({ username });
          if (existing) {
            sendJson(response, 409, { error: 'Username already exists' });
            return;
          }
          const user = {
            username,
            password: hashPassword(password),
            discordId: body.discordId || '',
            discordUsername: body.discordUsername || '',
            avatar: body.avatar || '',
            coins: body.coins ?? 0,
            role: 'user',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          const result = await db.collection('users').insertOne(user);
          user._id = result.insertedId;
          user.id = result.insertedId;
          sendJson(response, 201, normalizeUser(user));
        } else {
          const data = await readDataFile();
          if (data.users.find(u => u.username === username)) {
            sendJson(response, 409, { error: 'Username already exists' });
            return;
          }
          const user = {
            _id: createLocalId(),
            id: createLocalId(),
            username,
            password: hashPassword(password),
            discordId: body.discordId || '',
            discordUsername: body.discordUsername || '',
            avatar: body.avatar || '',
            coins: body.coins ?? 0,
            role: 'user',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          data.users.push(user);
          await writeDataFile(data);
          sendJson(response, 201, normalizeUser(user));
        }
        return;
      }

      if (action === 'discord') {
        const { discordId, discordUsername, avatar } = body;
        if (!discordId) {
          sendJson(response, 400, { error: 'discordId required' });
          return;
        }
        const db = await getDb();
        if (db) {
          const existing = await db.collection('users').findOne({ discordId });
          if (existing) {
            await db.collection('users').findOneAndUpdate(
              { discordId },
              { $set: { discordUsername, avatar, updatedAt: new Date().toISOString() } }
            );
            const updated = await db.collection('users').findOne({ discordId });
            sendJson(response, 200, normalizeUser(updated));
          } else {
            const user = {
              username: discordUsername || `discord_${discordId}`,
              password: '',
              discordId,
              discordUsername: discordUsername || '',
              avatar: avatar || '',
              coins: 0,
              role: 'user',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            const result = await db.collection('users').insertOne(user);
            user._id = result.insertedId;
            user.id = result.insertedId;
            sendJson(response, 201, normalizeUser(user));
          }
        } else {
          const data = await readDataFile();
          const existing = data.users.find(u => u.discordId === discordId);
          if (existing) {
            existing.discordUsername = discordUsername || existing.discordUsername;
            existing.avatar = avatar || existing.avatar;
            existing.updatedAt = new Date().toISOString();
            await writeDataFile(data);
            sendJson(response, 200, normalizeUser(existing));
          } else {
            const user = {
              _id: createLocalId(),
              id: createLocalId(),
              username: discordUsername || `discord_${discordId}`,
              password: '',
              discordId,
              discordUsername: discordUsername || '',
              avatar: avatar || '',
              coins: 0,
              role: 'user',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            data.users.push(user);
            await writeDataFile(data);
            sendJson(response, 201, normalizeUser(user));
          }
        }
        return;
      }

      sendJson(response, 400, { error: 'Invalid action' });
      return;
    }

    // POST /api/users/coins
    if (method === 'POST' && urlPath === '/api/users/coins') {
      const body = await readJson(request);
      const { userId, amount } = body;
      if (!userId || amount === undefined) {
        sendJson(response, 400, { error: 'userId and amount required' });
        return;
      }
      const db = await getDb();
      if (db) {
        const user = await db.collection('users').findOne({ _id: userId });
        if (!user) {
          sendJson(response, 404, { error: 'User not found' });
          return;
        }
        const currentCoins = user.coins ?? 0;
        const newCoins = Math.max(0, currentCoins + amount);
        await db.collection('users').findOneAndUpdate(
          { _id: userId },
          { $set: { coins: newCoins, updatedAt: new Date().toISOString() } }
        );
        sendJson(response, 200, { coins: newCoins });
      } else {
        const data = await readDataFile();
        const user = data.users.find(u => u._id === userId || u.id === userId);
        if (!user) {
          sendJson(response, 404, { error: 'User not found' });
          return;
        }
        user.coins = Math.max(0, (user.coins ?? 0) + amount);
        user.updatedAt = new Date().toISOString();
        await writeDataFile(data);
        sendJson(response, 200, { coins: user.coins });
      }
      return;
    }

    // GET /api/discord-users
    if (method === 'GET' && urlPath === '/api/discord-users') {
      const token = getLocalDiscordBotToken();
      if (!token) {
        sendJson(response, 400, { error: 'Discord bot token not configured' });
        return;
      }
      const res = await fetch(`https://discord.com/api/v10/guilds/${discordGuildId}/members?limit=1000`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!res.ok) {
        sendJson(response, 502, { error: `Discord API error: ${res.status}` });
        return;
      }
      const members = await res.json();
      sendJson(response, 200, members.map(normalizeDiscordMember));
      return;
    }

    // GET /api/discord/roles
    if (method === 'GET' && urlPath === '/api/discord/roles') {
      const token = getLocalDiscordBotToken();
      if (!token) {
        sendJson(response, 400, { error: 'Discord bot token not configured' });
        return;
      }
      const res = await fetch(`https://discord.com/api/v10/guilds/${discordGuildId}/roles`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!res.ok) {
        sendJson(response, 502, { error: `Discord API error: ${res.status}` });
        return;
      }
      const roles = await res.json();
      const filtered = roles
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.color, position: r.position }));
      sendJson(response, 200, filtered);
      return;
    }

    // GET /api/discord/channels
    if (method === 'GET' && urlPath === '/api/discord/channels') {
      const token = getLocalDiscordBotToken();
      if (!token) {
        sendJson(response, 400, { error: 'Discord bot token not configured' });
        return;
      }
      const res = await fetch(`https://discord.com/api/v10/guilds/${discordGuildId}/channels`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!res.ok) {
        sendJson(response, 502, { error: `Discord API error: ${res.status}` });
        return;
      }
      const channels = await res.json();
      const textChannels = channels
        .filter(c => c.type === 0)
        .sort((a, b) => a.position - b.position)
        .map(c => ({ id: c.id, name: c.name, parentId: c.parent_id }));
      sendJson(response, 200, textChannels);
      return;
    }

    // POST /api/discord-token
    if (method === 'POST' && urlPath === '/api/discord-token') {
      const body = await readJson(request);
      if (!body.token) {
        sendJson(response, 400, { error: 'Token required' });
        return;
      }
      const data = await readDataFile();
      data.settings = data.settings || {};
      data.settings.discordBotToken = body.token;
      await writeDataFile(data);
      sendJson(response, 200, { success: true });
      return;
    }

    // GET /api/bot/status
    if (method === 'GET' && urlPath === '/api/bot/status') {
      const token = getLocalDiscordBotToken();
      if (!token) {
        sendJson(response, 200, { status: 'disconnected', guilds: 0, users: 0, botName: null, botAvatar: null });
        return;
      }
      const userRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!userRes.ok) {
        sendJson(response, 200, { status: 'disconnected', guilds: 0, users: 0, botName: null, botAvatar: null });
        return;
      }
      const botUser = await userRes.json();
      const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bot ${token}` },
      });
      const guilds = guildsRes.ok ? await guildsRes.json() : [];
      sendJson(response, 200, {
        status: 'online',
        guilds: guilds.length,
        users: 0,
        botName: botUser.username,
        botAvatar: botUser.avatar
          ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
          : null,
      });
      return;
    }

    // POST /api/bot/sync
    if (method === 'POST' && urlPath === '/api/bot/sync') {
      const token = getLocalDiscordBotToken();
      if (!token) {
        sendJson(response, 400, { error: 'Discord bot token not configured' });
        return;
      }
      const userRes = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!userRes.ok) {
        sendJson(response, 502, { error: 'Failed to fetch bot info' });
        return;
      }
      const botUser = await userRes.json();
      const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bot ${token}` },
      });
      const guilds = guildsRes.ok ? await guildsRes.json() : [];
      const data = await readDataFile();
      data.settings = data.settings || {};
      data.settings.botInfo = {
        id: botUser.id,
        name: botUser.username,
        avatar: botUser.avatar
          ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
          : null,
        guilds: guilds.map(g => ({ id: g.id, name: g.name })),
        lastSync: new Date().toISOString(),
      };
      await writeDataFile(data);
      sendJson(response, 200, { success: true, botInfo: data.settings.botInfo });
      return;
    }

    // GET /api/site-settings
    if (method === 'GET' && urlPath === '/api/site-settings') {
      const params = new URL(request.url, `http://localhost:${port}`).searchParams;
      const key = params.get('key') || 'globalTheme';
      const db = await getDb();
      if (db) {
        const setting = await db.collection('settings').findOne({ key });
        sendJson(response, 200, setting || { key, value: null });
      } else {
        const data = await readDataFile();
        const settings = data.settings || {};
        sendJson(response, 200, { key, value: settings[key] ?? null });
      }
      return;
    }

    // POST /api/site-settings
    if (method === 'POST' && urlPath === '/api/site-settings') {
      const body = await readJson(request);
      const { key, value } = body;
      if (!key) {
        sendJson(response, 400, { error: 'key required' });
        return;
      }
      const db = await getDb();
      if (db) {
        await db.collection('settings').findOneAndUpdate(
          { key },
          { $set: { key, value, updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
        sendJson(response, 200, { key, value });
      } else {
        const data = await readDataFile();
        data.settings = data.settings || {};
        data.settings[key] = value;
        await writeDataFile(data);
        sendJson(response, 200, { key, value });
      }
      return;
    }

    sendJson(response, 404, { error: 'API route not found' });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

async function syncBotOnStartup() {
  try {
    const token = getLocalDiscordBotToken();
    if (!token) return;
    const userRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!userRes.ok) return;
    const botUser = await userRes.json();
    const guildsRes = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${token}` },
    });
    const guilds = guildsRes.ok ? await guildsRes.json() : [];
    const data = await readDataFile();
    data.settings = data.settings || {};
    data.settings.botInfo = {
      id: botUser.id,
      name: botUser.username,
      avatar: botUser.avatar
        ? `https://cdn.discordapp.com/avatars/${botUser.id}/${botUser.avatar}.png`
        : null,
      guilds: guilds.map(g => ({ id: g.id, name: g.name })),
      lastSync: new Date().toISOString(),
    };
    await writeDataFile(data);
    console.log('Bot info synced on startup');
  } catch (err) {
    console.error('Startup sync failed:', err.message);
  }
}

const server = http.createServer(async (request, response) => {
  const { url, method } = request;
  const parsedUrl = new URL(url, `http://localhost:${port}`);
  const urlPath = parsedUrl.pathname;

  if (urlPath.startsWith('/api/')) {
    await handleApi(request, response, urlPath);
    return;
  }

  const filePath = resolvePath(urlPath);
  if (!filePath) {
    response.writeHead(404, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    response.end('Not Found');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      await fs.access(indexPath);
      const ext = path.extname(indexPath);
      const content = await fs.readFile(indexPath);
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      response.end(content);
      return;
    }
    const ext = path.extname(filePath);
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(content);
  } catch {
    response.writeHead(404, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    response.end('Not Found');
  }
});

server.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}`);
  syncBotOnStartup();
});
