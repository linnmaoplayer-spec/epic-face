
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BIN = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;
const KEY = process.env.JSONBIN_ACCESS_KEY;

if (!process.env.JSONBIN_BIN_ID || !KEY || !process.env.SESSION_SECRET) {
  console.error("Configure o arquivo .env antes de iniciar.");
  process.exit(1);
}

app.use(express.json({ limit: "600kb" }));
app.use(session({
  name: "epicchat.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 86400000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const headers = {
  "Content-Type": "application/json",
  "X-Access-Key": KEY
};

let db;
let queue = Promise.resolve();

function emptyDB() {
  return {
    users: [],
    messages: [],
    servers: [],
    invites: [],
    nextPlayer: 1,
    nextServer: 1
  };
}

function playerId() {
  let n = db.nextPlayer++;
  let a = Math.floor((n - 1) / 100000) % 1000;
  let b = n % 1000;
  let c = n % 10;
  return `${String(a).padStart(3,"0")}:${String(b).padStart(3,"0")}.${c}`;
}

function serverId() {
  return `SRV-${String(db.nextServer++).padStart(6,"0")}`;
}

function inviteCode() {
  let code;
  do {
    code = "EPIC-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  } while (db.invites.some(x => x.code === code));
  return code;
}

function normalize(data) {
  data = data && typeof data === "object" ? data : emptyDB();
  data.users = Array.isArray(data.users) ? data.users : [];
  data.messages = Array.isArray(data.messages) ? data.messages : [];
  data.servers = Array.isArray(data.servers) ? data.servers : [];
  data.invites = Array.isArray(data.invites) ? data.invites : [];
  data.nextPlayer = Number(data.nextPlayer) || 1;
  data.nextServer = Number(data.nextServer) || 1;

  const changes = new Map();

  for (const u of data.users) {
    const old = u.id;
    if (!/^\d{3}:\d{3}\.\d$/.test(String(u.id || ""))) {
      let n = data.nextPlayer++;
      u.id = `${String(Math.floor((n-1)/100000)%1000).padStart(3,"0")}:${String(n%1000).padStart(3,"0")}.${n%10}`;
      if (old) changes.set(old, u.id);
    }
    u.friends = Array.isArray(u.friends) ? u.friends : [];
    u.servers = Array.isArray(u.servers) ? u.servers : [];
    u.avatar ??= null;
  }

  const fix = id => changes.get(id) || id;

  for (const u of data.users) u.friends = u.friends.map(fix);
  for (const m of data.messages) {
    m.from = fix(m.from);
    m.to = fix(m.to);
  }
  for (const s of data.servers) {
    s.owner = fix(s.owner);
    s.members = (s.members || []).map(fix);
  }
  for (const i of data.invites) i.createdBy = fix(i.createdBy);

  return data;
}

async function loadDB() {
  const r = await fetch(BIN + "/latest", { headers });
  if (!r.ok) throw new Error("JSONBin GET: " + r.status);
  const json = await r.json();
  return normalize(json.record);
}

async function saveDB() {
  const r = await fetch(BIN, {
    method: "PUT",
    headers,
    body: JSON.stringify(db)
  });
  if (!r.ok) throw new Error("JSONBin PUT: " + r.status);
}

function transaction(fn) {
  const job = queue.then(async () => {
    const backup = structuredClone(db);
    try {
      const result = await fn();
      await saveDB();
      return result;
    } catch (e) {
      db = backup;
      throw e;
    }
  });
  queue = job.catch(() => {});
  return job;
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function auth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Faça login novamente." });
  }
  next();
}

function me(req) {
  return db.users.find(u => u.id === req.session.userId);
}

function findUser(id) {
  return db.users.find(u => u.id === id);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    avatar: u.avatar || null,
    friends: u.friends || [],
    servers: u.servers || [],
    createdAt: u.createdAt
  };
}

function username(value) {
  if (typeof value !== "string") fail("Nome inválido.");
  value = value.trim();
  if (value.length < 3 || value.length > 24) {
    fail("O nome deve ter entre 3 e 24 caracteres.");
  }
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    fail("Use letras, números e underline.");
  }
  return value;
}

function avatar(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 480000) {
    fail("Imagem muito grande. Limite: aproximadamente 350 KB.");
  }
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    fail("Formato de imagem inválido.");
  }
  return value;
}

function member(server, id) {
  return server.owner === id || server.members.includes(id);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "epic_chat.html"));
});

// CADASTRO

app.post("/api/register", async (req, res) => {
  try {
    const name = username(req.body.username);
    const password = req.body.password;

    if (typeof password !== "string" || password.length < 6 || password.length > 128) {
      fail("A senha precisa ter entre 6 e 128 caracteres.");
    }

    const user = await transaction(async () => {
      if (db.users.some(u => u.username.toLowerCase() === name.toLowerCase())) {
        fail("Esse nome já está em uso.", 409);
      }

      const u = {
        id: playerId(),
        username: name,
        passwordHash: await bcrypt.hash(password, 12),
        avatar: null,
        friends: [],
        servers: [],
        createdAt: new Date().toISOString()
      };
      db.users.push(u);
      return publicUser(u);
    });

    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Erro na sessão." });
      req.session.userId = user.id;
      req.session.save(() => res.status(201).json({ user }));
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// LOGIN

app.post("/api/login", async (req, res) => {
  try {
    const name = String(req.body.username || "").trim();
    const password = req.body.password;
    const u = db.users.find(x => x.username.toLowerCase() === name.toLowerCase());

    if (!u || typeof password !== "string" || !(await bcrypt.compare(password, u.passwordHash))) {
      fail("Usuário ou senha incorretos.", 401);
    }

    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Erro na sessão." });
      req.session.userId = u.id;
      req.session.save(() => res.json({ user: publicUser(u) }));
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/me", auth, (req, res) => {
  const u = me(req);
  if (!u) return res.status(404).json({ error: "Conta não encontrada." });
  res.json({ user: publicUser(u) });
});

app.post("/api/logout", auth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("epicchat.sid");
    res.json({ success: true });
  });
});

// PERFIL

app.patch("/api/profile", auth, async (req, res) => {
  try {
    const name = req.body.username === undefined ? undefined : username(req.body.username);
    const image = req.body.avatar === undefined ? undefined : avatar(req.body.avatar);

    const user = await transaction(() => {
      const u = me(req);
      if (!u) fail("Conta não encontrada.", 404);

      if (name && db.users.some(x =>
        x.id !== u.id && x.username.toLowerCase() === name.toLowerCase()
      )) fail("Esse nome já está em uso.", 409);

      if (name) u.username = name;
      if (image !== undefined) u.avatar = image;
      return publicUser(u);
    });

    res.json({ user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// BUSCA DE USUÁRIOS

app.get("/api/users/search", auth, (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const users = db.users
    .filter(u => u.id !== req.session.userId &&
      (u.username.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)))
    .slice(0, 20)
    .map(publicUser);
  res.json({ users });
});

// AMIGOS

async function addFriend(req, res) {
  try {
    const q = String(req.body.user || req.body.friendId || "").trim().toLowerCase();

    const friend = await transaction(() => {
      const u = me(req);
      const target = db.users.find(x =>
        x.id.toLowerCase() === q || x.username.toLowerCase() === q
      );

      if (!target) fail("Usuário não encontrado.", 404);
      if (target.id === u.id) fail("Você não pode adicionar a si mesmo.");
      if (u.friends.includes(target.id)) fail("Já é seu amigo.");

      u.friends.push(target.id);
      target.friends ||= [];
      if (!target.friends.includes(u.id)) target.friends.push(u.id);
      return publicUser(target);
    });

    res.json({ success: true, friend });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

app.post("/api/friends", auth, addFriend);
app.post("/api/friends/request", auth, addFriend);

app.get("/api/friends", auth, (req, res) => {
  const u = me(req);
  res.json({ friends: u.friends.map(findUser).filter(Boolean).map(publicUser) });
});

app.delete("/api/friends/:id", auth, async (req, res) => {
  try {
    await transaction(() => {
      const u = me(req);
      const f = findUser(req.params.id);
      if (!f) fail("Amigo não encontrado.", 404);
      u.friends = u.friends.filter(id => id !== f.id);
      f.friends = f.friends.filter(id => id !== u.id);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// MENSAGENS

app.get("/api/messages/:friendId", auth, (req, res) => {
  const u = me(req);
  const id = req.params.friendId;

  if (!u.friends.includes(id)) {
    return res.status(403).json({ error: "Esse usuário não é seu amigo." });
  }

  const messages = db.messages
    .filter(m =>
      (m.from === u.id && m.to === id) ||
      (m.from === id && m.to === u.id)
    )
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(m => ({ ...m, sender: publicUser(findUser(m.from)) }));

  res.json({ messages });
});

app.post("/api/messages", auth, async (req, res) => {
  try {
    const to = String(req.body.to || "");
    const text = String(req.body.text || "").trim();

    if (!text || text.length > 2000) fail("Mensagem inválida.");
    const message = await transaction(() => {
      const u = me(req);
      const target = findUser(to);
      if (!target) fail("Destinatário não encontrado.", 404);
      if (!u.friends.includes(target.id)) fail("Vocês precisam ser amigos.", 403);

      const m = {
        id: crypto.randomUUID(),
        from: u.id,
        to: target.id,
        text,
        createdAt: new Date().toISOString()
      };
      db.messages.push(m);
      return m;
    });

    res.status(201).json({ message });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// SERVIDORES

app.get("/api/servers", auth, (req, res) => {
  const u = me(req);
  const servers = db.servers
    .filter(s => member(s, u.id))
    .map(s => ({
      id: s.id,
      name: s.name,
      owner: s.owner,
      memberCount: s.members.length + 1
    }));
  res.json({ servers });
});

app.post("/api/servers", auth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (name.length < 2 || name.length > 32) fail("Nome do servidor: 2 a 32 caracteres.");

    const server = await transaction(() => {
      const u = me(req);
      const s = {
        id: serverId(),
        name,
        owner: u.id,
        members: [],
        createdAt: new Date().toISOString()
      };
      db.servers.push(s);
      u.servers.push(s.id);
      return s;
    });

    res.status(201).json({ server });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/servers/:id", auth, (req, res) => {
  const s = db.servers.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Servidor não encontrado." });
  if (!member(s, req.session.userId)) {
    return res.status(403).json({ error: "Você não participa desse servidor." });
  }

  const members = [s.owner, ...s.members].map(findUser).filter(Boolean).map(publicUser);
  res.json({ server: { id: s.id, name: s.name, owner: s.owner, members } });
});

// CONVITES

app.post("/api/servers/:id/invites", auth, async (req, res) => {
  try {
    const invite = await transaction(() => {
      const s = db.servers.find(x => x.id === req.params.id);
      if (!s) fail("Servidor não encontrado.", 404);
      if (!member(s, req.session.userId)) fail("Você não participa desse servidor.", 403);

      const i = {
        code: inviteCode(),
        serverId: s.id,
        createdBy: req.session.userId,
        createdAt: new Date().toISOString()
      };
      db.invites.push(i);
      return i;
    });
    res.status(201).json({ invite });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/invites/join", auth, async (req, res) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();

    const server = await transaction(() => {
      const u = me(req);
      const i = db.invites.find(x => x.code === code);
      if (!i) fail("Convite inválido.", 404);

      const s = db.servers.find(x => x.id === i.serverId);
      if (!s) fail("Servidor não encontrado.", 404);

      if (!member(s, u.id)) {
        s.members.push(u.id);
        if (!u.servers.includes(s.id)) u.servers.push(s.id);
      }
      return { id: s.id, name: s.name };
    });

    res.json({ server });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ATUALIZAÇÃO

app.get("/api/updates", auth, (req, res) => {
  const u = me(req);
  res.json({
    user: publicUser(u),
    friends: u.friends.map(findUser).filter(Boolean).map(publicUser),
    servers: db.servers.filter(s => member(s, u.id)).map(s => ({
      id: s.id,
      name: s.name,
      owner: s.owner,
      memberCount: s.members.length + 1
    })),
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/status", (req, res) => {
  res.json({ online: true, database: db ? "connected" : "disconnected" });
});

async function start() {
  console.log("Conectando ao JSONBin...");
  db = await loadDB();
  await saveDB();
  console.log("Banco carregado. Contas:", db.users.length);
  app.listen(PORT, () => console.log(`EPIC CHAT: http://localhost:${PORT}`));
}

start().catch(e => {
  console.error("Erro ao iniciar:", e);
  process.exit(1);
});
