
"use strict";

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const BIN_ID = process.env.JSONBIN_BIN_ID;
const BIN_KEY = process.env.JSONBIN_ACCESS_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!BIN_ID || !BIN_KEY || !SESSION_SECRET) {
    console.error("ERRO: configure JSONBIN_BIN_ID, JSONBIN_ACCESS_KEY e SESSION_SECRET.");
    process.exit(1);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    name: "epicchat.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

let db = {
    users: [],
    messages: [],
    servers: [],
    invites: [],
    updatedAt: null
};

let databaseReady = false;
let saveQueue = Promise.resolve();

const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

async function jsonBinRequest(method, body) {
    const response = await fetch(
        method === "GET" ? `${BIN_URL}/latest` : BIN_URL,
        {
            method,
            headers: {
                "Content-Type": "application/json",
                "X-Access-Key": BIN_KEY
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        }
    );

    const text = await response.text();

    if (!response.ok) {
        throw new Error(`JSONBin respondeu ${response.status}: ${text}`);
    }

    return text ? JSON.parse(text) : {};
}

async function loadDatabase() {
    console.log("Conectando ao JSONBin...");

    const result = await jsonBinRequest("GET");
    const record = result.record || {};

    db = {
        ...record,
        users: Array.isArray(record.users) ? record.users : [],
        messages: Array.isArray(record.messages) ? record.messages : [],
        servers: Array.isArray(record.servers) ? record.servers : [],
        invites: Array.isArray(record.invites) ? record.invites : [],
        updatedAt: record.updatedAt || null
    };

    for (const user of db.users) {
        if (!Array.isArray(user.friends)) user.friends = [];
        if (!user.id) user.id = generatePlayerId();
    }

    databaseReady = true;

    console.log("Banco de dados carregado.");
    console.log("Contas cadastradas:", db.users.length);
}

function saveDatabase() {
    const task = saveQueue.catch(() => {}).then(async () => {
        db.updatedAt = new Date().toISOString();
        await jsonBinRequest("PUT", db);
    });

    saveQueue = task;
    return task;
}

function generatePlayerId() {
    const number = crypto.randomInt(0, 10000000);
    const value = String(number).padStart(7, "0");

    return `${value.slice(0, 3)}:${value.slice(3, 6)}.${value.slice(6)}`;
}

function generateServerId() {
    return "SRV-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function generateInviteCode() {
    return "EPIC-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function findUser(value) {
    if (!value) return null;

    const search = String(value).trim().toLowerCase();

    return db.users.find(user =>
        user.id.toLowerCase() === search ||
        user.username.toLowerCase() === search
    ) || null;
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        avatar: user.avatar || "",
        status: user.status || "offline"
    };
}

function requireDatabase(req, res, next) {
    if (!databaseReady) {
        return res.status(503).json({
            error: "O banco de dados ainda está carregando."
        });
    }

    next();
}

function requireLogin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            error: "Você precisa entrar na sua conta."
        });
    }

    const user = db.users.find(u => u.id === req.session.userId);

    if (!user) {
        return res.status(401).json({
            error: "Conta não encontrada. Entre novamente."
        });
    }

    req.user = user;
    next();
}

app.use(requireDatabase);

// Arquivos públicos: não exponha server.js nem .env.
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "epic_chat.html"));
});

app.get("/epic_chat.html", (req, res) => {
    res.sendFile(path.join(__dirname, "epic_chat.html"));
});

app.get("/epic_chat.css", (req, res) => {
    res.sendFile(path.join(__dirname, "epic_chat.css"));
});

app.get("/script.js", (req, res) => {
    res.sendFile(path.join(__dirname, "script.js"));
});

app.get("/icon.png", (req, res) => {
    res.sendFile(path.join(__dirname, "icon.png"));
});

// ==============================
// AUTENTICAÇÃO
// ==============================

app.post("/api/register", async (req, res, next) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        if (username.length < 3 || username.length > 24) {
            return res.status(400).json({
                error: "O nome precisa ter entre 3 e 24 caracteres."
            });
        }

        if (!/^[\p{L}\p{N}_]+$/u.test(username)) {
            return res.status(400).json({
                error: "Use apenas letras, números e underline no nome."
            });
        }

        if (password.length < 6 || password.length > 128) {
            return res.status(400).json({
                error: "A senha precisa ter entre 6 e 128 caracteres."
            });
        }

        if (db.users.some(u =>
            u.username.toLowerCase() === username.toLowerCase()
        )) {
            return res.status(409).json({
                error: "Esse nome já está sendo usado."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        let id;

        do {
            id = generatePlayerId();
        } while (db.users.some(u => u.id === id));

        const user = {
            id,
            username,
            password: passwordHash,
            avatar: "",
            friends: [],
            status: "online",
            createdAt: new Date().toISOString()
        };

        db.users.push(user);
        await saveDatabase();

        req.session.userId = user.id;

        req.session.save(error => {
            if (error) return next(error);

            res.status(201).json({
                ok: true,
                user: publicUser(user)
            });
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/login", async (req, res, next) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        const user = db.users.find(u =>
            u.username.toLowerCase() === username.toLowerCase()
        );

        if (!user) {
            return res.status(401).json({
                error: "Nome de usuário ou senha incorretos."
            });
        }

        let valid = false;

        if (String(user.password).startsWith("$2")) {
            valid = await bcrypt.compare(password, user.password);
        } else {
            // Compatibilidade com contas antigas.
            valid = user.password === password;

            if (valid) {
                user.password = await bcrypt.hash(password, 12);
            }
        }

        if (!valid) {
            return res.status(401).json({
                error: "Nome de usuário ou senha incorretos."
            });
        }

        req.session.regenerate(error => {
            if (error) return next(error);

            req.session.userId = user.id;
            user.status = "online";

            saveDatabase()
                .then(() => {
                    req.session.save(sessionError => {
                        if (sessionError) return next(sessionError);

                        res.json({
                            ok: true,
                            user: publicUser(user)
                        });
                    });
                })
                .catch(next);
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/logout", requireLogin, async (req, res, next) => {
    try {
        req.user.status = "offline";
        await saveDatabase();

        req.session.destroy(error => {
            if (error) return next(error);

            res.clearCookie("epicchat.sid");
            res.json({ ok: true });
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/me", requireLogin, (req, res) => {
    res.json({
        user: publicUser(req.user)
    });
});

// ==============================
// PESQUISA
// ==============================

app.get("/api/users/search", requireLogin, (req, res) => {
    const query = String(req.query.q || "").trim().toLowerCase();

    if (!query) {
        return res.json({ users: [] });
    }

    const users = db.users
        .filter(user =>
            user.id.toLowerCase().includes(query) ||
            user.username.toLowerCase().includes(query)
        )
        .filter(user => user.id !== req.user.id)
        .slice(0, 30)
        .map(publicUser);

    res.json({ users });
});

// ==============================
// PERFIL
// ==============================

app.patch("/api/profile", requireLogin, async (req, res, next) => {
    try {
        const username = String(req.body.username || "").trim();
        const avatar = String(req.body.avatar || "");

        if (username.length < 3 || username.length > 24) {
            return res.status(400).json({
                error: "O nome precisa ter entre 3 e 24 caracteres."
            });
        }

        if (!/^[\p{L}\p{N}_]+$/u.test(username)) {
            return res.status(400).json({
                error: "Use apenas letras, números e underline."
            });
        }

        const duplicate = db.users.find(user =>
            user.id !== req.user.id &&
            user.username.toLowerCase() === username.toLowerCase()
        );

        if (duplicate) {
            return res.status(409).json({
                error: "Esse nome já está sendo usado."
            });
        }

        if (avatar && !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(avatar)) {
            return res.status(400).json({
                error: "Formato de imagem inválido."
            });
        }

        if (avatar.length > 5_000_000) {
            return res.status(413).json({
                error: "A imagem é muito grande."
            });
        }

        req.user.username = username;
        req.user.avatar = avatar;

        await saveDatabase();

        res.json({
            ok: true,
            user: publicUser(req.user)
        });
    } catch (error) {
        next(error);
    }
});

// ==============================
// AMIGOS
// ==============================

app.get("/api/friends", requireLogin, (req, res) => {
    const friends = req.user.friends
        .map(id => db.users.find(user => user.id === id))
        .filter(Boolean)
        .map(publicUser);

    res.json({ friends });
});

app.post("/api/friends/request", requireLogin, async (req, res, next) => {
    try {
        const target = findUser(req.body.user || req.body.userId);

        if (!target) {
            return res.status(404).json({
                error: "Usuário não encontrado."
            });
        }

        if (target.id === req.user.id) {
            return res.status(400).json({
                error: "Você não pode adicionar sua própria conta."
            });
        }

        if (!req.user.friends.includes(target.id)) {
            req.user.friends.push(target.id);
        }

        if (!target.friends.includes(req.user.id)) {
            target.friends.push(req.user.id);
        }

        await saveDatabase();

        res.json({
            ok: true,
            friend: publicUser(target)
        });
    } catch (error) {
        next(error);
    }
});

app.delete("/api/friends/:id", requireLogin, async (req, res, next) => {
    try {
        const target = findUser(req.params.id);

        if (!target) {
            return res.status(404).json({
                error: "Usuário não encontrado."
            });
        }

        req.user.friends = req.user.friends.filter(id => id !== target.id);
        target.friends = target.friends.filter(id => id !== req.user.id);

        await saveDatabase();

        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

// ==============================
// MENSAGENS
// ==============================

app.get("/api/messages/:userId", requireLogin, (req, res) => {
    const target = findUser(req.params.userId);

    if (!target) {
        return res.status(404).json({
            error: "Usuário não encontrado."
        });
    }

    const messages = db.messages
        .filter(message =>
            (message.from === req.user.id && message.to === target.id) ||
            (message.from === target.id && message.to === req.user.id)
        )
        .sort((a, b) =>
            new Date(a.createdAt) - new Date(b.createdAt)
        )
        .slice(-300)
        .map(message => {
            const sender = db.users.find(u => u.id === message.from);

            return {
                ...message,
                sender: sender ? publicUser(sender) : null
            };
        });

    res.json({ messages });
});

app.post("/api/messages", requireLogin, async (req, res, next) => {
    try {
        const target = findUser(req.body.to);
        const text = String(req.body.text || "").trim();

        if (!target) {
            return res.status(404).json({
                error: "Destinatário não encontrado."
            });
        }

        if (!text || text.length > 5000) {
            return res.status(400).json({
                error: "A mensagem precisa ter entre 1 e 5000 caracteres."
            });
        }

        const message = {
            id: crypto.randomUUID(),
            from: req.user.id,
            to: target.id,
            text,
            createdAt: new Date().toISOString()
        };

        db.messages.push(message);
        await saveDatabase();

        res.status(201).json({
            ok: true,
            message: {
                ...message,
                sender: publicUser(req.user)
            }
        });
    } catch (error) {
        next(error);
    }
});

// ==============================
// SERVIDORES E CONVITES
// ==============================

app.get("/api/servers", requireLogin, (req, res) => {
    const servers = db.servers.filter(server =>
        server.members.includes(req.user.id)
    );

    res.json({ servers });
});

app.post("/api/servers", requireLogin, async (req, res, next) => {
    try {
        const name = String(req.body.name || "").trim();

        if (name.length < 2 || name.length > 40) {
            return res.status(400).json({
                error: "O nome do servidor precisa ter entre 2 e 40 caracteres."
            });
        }

        const server = {
            id: generateServerId(),
            name,
            owner: req.user.id,
            members: [req.user.id],
            createdAt: new Date().toISOString()
        };

        db.servers.push(server);
        await saveDatabase();

        res.status(201).json({
            ok: true,
            server
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/servers/:serverId/invites", requireLogin, async (req, res, next) => {
    try {
        const server = db.servers.find(s => s.id === req.params.serverId);

        if (!server || !server.members.includes(req.user.id)) {
            return res.status(404).json({
                error: "Servidor não encontrado."
            });
        }

        const invite = {
            code: generateInviteCode(),
            serverId: server.id,
            createdBy: req.user.id,
            createdAt: new Date().toISOString()
        };

        db.invites.push(invite);
        await saveDatabase();

        res.json({ invite });
    } catch (error) {
        next(error);
    }
});

app.post("/api/invites/join", requireLogin, async (req, res, next) => {
    try {
        const code = String(req.body.code || "").trim().toUpperCase();

        const invite = db.invites.find(i => i.code === code);

        if (!invite) {
            return res.status(404).json({
                error: "Convite inválido."
            });
        }

        const server = db.servers.find(s => s.id === invite.serverId);

        if (!server) {
            return res.status(404).json({
                error: "Servidor não encontrado."
            });
        }

        if (!server.members.includes(req.user.id)) {
            server.members.push(req.user.id);
        }

        await saveDatabase();

        res.json({
            ok: true,
            server
        });
    } catch (error) {
        next(error);
    }
});

// ==============================
// ATUALIZAÇÕES
// ==============================

app.get("/api/updates", requireLogin, (req, res) => {
    res.json({
        version: "2.0.0",
        updatedAt: db.updatedAt,
        online: db.users.filter(u => u.status === "online").length
    });
});

// ==============================
// ERROS
// ==============================

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "Rota da API não encontrada."
    });
});

app.use((error, req, res, next) => {
    console.error("ERRO:", error);

    if (res.headersSent) return next(error);

    res.status(500).json({
        error: "Erro interno do servidor."
    });
});

// ==============================
// INICIAR
// ==============================

async function start() {
    try {
        await loadDatabase();

        app.listen(PORT, () => {
            console.log("");
            console.log("================================");
            console.log("       EPIC CHAT ONLINE");
            console.log("================================");
            console.log("Servidor: http://localhost:" + PORT);
            console.log("Banco: JSONBin conectado");
            console.log("================================");
        });
    } catch (error) {
        console.error("Não foi possível iniciar:", error);
        process.exit(1);
    }
}

start();
