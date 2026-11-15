
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_ACCESS_KEY = process.env.JSONBIN_ACCESS_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!JSONBIN_BIN_ID || !JSONBIN_ACCESS_KEY || !SESSION_SECRET) {
    console.error("ERRO: configure JSONBIN_BIN_ID, JSONBIN_ACCESS_KEY e SESSION_SECRET.");
    process.exit(1);
}

app.set("trust proxy", 1);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

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

// ======================================================
// BANCO DE DADOS
// ======================================================

let db = {
    users: [],
    messages: [],
    servers: [],
    invites: [],
    nextServer: 1,
    updatedAt: null
};

let databaseReady = false;
let saveQueue = Promise.resolve();

async function jsonBinRequest(method, data = null) {
    const url = method === "GET"
        ? `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`
        : `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

    const response = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            "X-Access-Key": JSONBIN_ACCESS_KEY,
            "X-Bin-Meta": "false"
        },
        ...(data ? { body: JSON.stringify(data) } : {})
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(`JSONBin ${response.status}: ${text}`);
    }

    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function loadDB() {
    console.log("Conectando ao JSONBin...");

    const result = await jsonBinRequest("GET");

    let saved = result?.record || result || {};

    if (typeof saved !== "object" || Array.isArray(saved)) {
        saved = {};
    }

    db = {
        ...db,
        ...saved,
        users: Array.isArray(saved.users) ? saved.users : [],
        messages: Array.isArray(saved.messages) ? saved.messages : [],
        servers: Array.isArray(saved.servers) ? saved.servers : [],
        invites: Array.isArray(saved.invites) ? saved.invites : [],
        nextServer: Number(saved.nextServer) || 1
    };

    // Corrige dados antigos de usuários
    for (const user of db.users) {
        if (!user.id) user.id = generatePlayerID();
        if (!Array.isArray(user.friends)) user.friends = [];
        if (!user.avatar) user.avatar = "";
        if (!user.createdAt) user.createdAt = new Date().toISOString();
        if (!user.status) user.status = "offline";
    }

    databaseReady = true;

    console.log("Banco de dados carregado.");
    console.log("Contas cadastradas:", db.users.length);
}

function saveDB() {
    const task = saveQueue.catch(() => {}).then(async () => {
        db.updatedAt = new Date().toISOString();
        await jsonBinRequest("PUT", db);
    });

    saveQueue = task;
    return task;
}

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function generatePlayerID() {
    const number = crypto.randomInt(0, 10000000);
    const value = String(number).padStart(7, "0");

    return `${value.slice(0, 3)}:${value.slice(3, 6)}.${value.slice(6)}`;
}

function generateServerID() {
    const number = db.nextServer++;
    return `SRV-${String(number).padStart(6, "0")}`;
}

function generateInviteCode() {
    return "EPIC-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function findUserByID(id) {
    return db.users.find(user => user.id === id);
}

function findUserByUsername(username) {
    return db.users.find(
        user => user.username.toLowerCase() === String(username).toLowerCase()
    );
}

function publicUser(user) {
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        avatar: user.avatar || "",
        status: user.status || "offline",
        createdAt: user.createdAt
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

function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({
            error: "Você precisa entrar na sua conta."
        });
    }

    const user = findUserByID(req.session.userId);

    if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({
            error: "Sessão inválida. Entre novamente."
        });
    }

    req.user = user;
    next();
}

function validUsername(username) {
    return typeof username === "string" &&
        username.trim().length >= 3 &&
        username.trim().length <= 24 &&
        /^[\p{L}\p{N}_ .-]+$/u.test(username.trim());
}

function validPassword(password) {
    return typeof password === "string" &&
        password.length >= 6 &&
        password.length <= 128;
}

// ======================================================
// ARQUIVOS DO SITE
// ======================================================

function sendPublicFile(filename, res) {
    const filePath = path.join(__dirname, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("Arquivo não encontrado: " + filename);
    }

    res.sendFile(filePath);
}

app.get("/", (req, res) => {
    sendPublicFile("epic_chat.html", res);
});

app.get("/epic_chat.html", (req, res) => {
    sendPublicFile("epic_chat.html", res);
});

app.get("/epic_chat.css", (req, res) => {
    sendPublicFile("epic_chat.css", res);
});

app.get("/epic_chat.js", (req, res) => {
    sendPublicFile("epic_chat.js", res);
});

app.get("/icon.png", (req, res) => {
    sendPublicFile("icon.png", res);
});

// ======================================================
// CADASTRO
// ======================================================

app.post("/api/register", requireDatabase, async (req, res, next) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = req.body.password;

        if (!validUsername(username)) {
            return res.status(400).json({
                error: "O nome deve ter entre 3 e 24 caracteres. Use letras, números e _ . -"
            });
        }

        if (!validPassword(password)) {
            return res.status(400).json({
                error: "A senha precisa ter entre 6 e 128 caracteres."
            });
        }

        if (findUserByUsername(username)) {
            return res.status(409).json({
                error: "Esse nome de usuário já está em uso."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        let playerID;

        do {
            playerID = generatePlayerID();
        } while (findUserByID(playerID));

        const user = {
            id: playerID,
            username,
            password: passwordHash,
            avatar: "",
            friends: [],
            status: "online",
            createdAt: new Date().toISOString()
        };

        db.users.push(user);

        await saveDB();

        req.session.regenerate(err => {
            if (err) return next(err);

            req.session.userId = user.id;

            req.session.save(saveError => {
                if (saveError) return next(saveError);

                res.status(201).json({
                    success: true,
                    user: publicUser(user)
                });
            });
        });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// LOGIN
// ======================================================

app.post("/api/login", requireDatabase, async (req, res, next) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = req.body.password;

        if (!username || typeof password !== "string") {
            return res.status(400).json({
                error: "Preencha o usuário e a senha."
            });
        }

        const user = findUserByUsername(username);

        if (!user) {
            return res.status(401).json({
                error: "Usuário ou senha incorretos."
            });
        }

        let passwordCorrect = false;

        if (String(user.password).startsWith("$2")) {
            passwordCorrect = await bcrypt.compare(password, user.password);
        } else {
            // Compatibilidade com contas antigas.
            passwordCorrect = user.password === password;

            if (passwordCorrect) {
                user.password = await bcrypt.hash(password, 12);
            }
        }

        if (!passwordCorrect) {
            return res.status(401).json({
                error: "Usuário ou senha incorretos."
            });
        }

        req.session.regenerate(async err => {
            if (err) return next(err);

            req.session.userId = user.id;
            user.status = "online";
            user.lastSeen = new Date().toISOString();

            try {
                await saveDB();

                req.session.save(sessionError => {
                    if (sessionError) return next(sessionError);

                    res.json({
                        success: true,
                        user: publicUser(user)
                    });
                });
            } catch (error) {
                next(error);
            }
        });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// SESSÃO ATUAL
// ======================================================

app.get("/api/me", requireDatabase, requireAuth, (req, res) => {
    res.json({
        user: publicUser(req.user)
    });
});

// ======================================================
// LOGOUT
// ======================================================

app.post("/api/logout", requireAuth, async (req, res, next) => {
    try {
        req.user.status = "offline";
        req.user.lastSeen = new Date().toISOString();

        await saveDB();

        req.session.destroy(err => {
            if (err) return next(err);

            res.clearCookie("epicchat.sid", {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax"
            });

            res.json({ success: true });
        });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// PESQUISAR USUÁRIOS POR NOME OU ID
// ======================================================

app.get("/api/users/search", requireDatabase, requireAuth, (req, res) => {
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

// ======================================================
// EDITAR PERFIL
// ======================================================

app.patch("/api/profile", requireDatabase, requireAuth, async (req, res, next) => {
    try {
        const username = String(req.body.username || "").trim();
        const avatar = req.body.avatar;

        if (!validUsername(username)) {
            return res.status(400).json({
                error: "O nome deve ter entre 3 e 24 caracteres."
            });
        }

        const existing = findUserByUsername(username);

        if (existing && existing.id !== req.user.id) {
            return res.status(409).json({
                error: "Esse nome já está sendo usado."
            });
        }

        if (avatar !== undefined && avatar !== "") {
            if (typeof avatar !== "string" ||
                !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(avatar) ||
                avatar.length > 5 * 1024 * 1024) {
                return res.status(400).json({
                    error: "Imagem inválida ou muito grande."
                });
            }

            req.user.avatar = avatar;
        }

        req.user.username = username;

        await saveDB();

        res.json({
            success: true,
            user: publicUser(req.user)
        });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// AMIGOS
// ======================================================

app.get("/api/friends", requireDatabase, requireAuth, (req, res) => {
    const friends = req.user.friends
        .map(id => findUserByID(id))
        .filter(Boolean)
        .map(publicUser);

    res.json({ friends });
});

// Adiciona um amigo diretamente.
app.post("/api/friends/request", requireDatabase, requireAuth, async (req, res, next) => {
    try {
        const targetID = String(req.body.userId || req.body.id || "");
        const target = findUserByID(targetID);

        if (!target) {
            return res.status(404).json({
                error: "Usuário não encontrado."
            });
        }

        if (target.id === req.user.id) {
            return res.status(400).json({
                error: "Você não pode adicionar a si mesmo."
            });
        }

        if (!req.user.friends.includes(target.id)) {
            req.user.friends.push(target.id);
        }

        if (!target.friends.includes(req.user.id)) {
            target.friends.push(req.user.id);
        }

        await saveDB();

        res.json({
            success: true,
            user: publicUser(target)
        });
    } catch (error) {
        next(error);
    }
});

app.delete("/api/friends/:userId", requireDatabase, requireAuth, async (req, res, next) => {
    try {
        const target = findUserByID(req.params.userId);

        req.user.friends = req.user.friends.filter(
            id => id !== req.params.userId
        );

        if (target) {
            target.friends = target.friends.filter(
                id => id !== req.user.id
            );
        }

        await saveDB();

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// MENSAGENS
// ======================================================

app.get("/api/messages/:username", requireDatabase, requireAuth, (req, res) => {
    const targetName = decodeURIComponent(req.params.username);
    const target = findUserByID(targetName) || findUserByUsername(targetName);

    if (!target) {
        return res.status(404).json({
            error: "Usuário não encontrado.",
            messages: []
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
            const sender = findUserByID(message.from);

            return {
                ...message,
                sender: publicUser(sender)
            };
        });

    res.json({ messages });
});

async function sendMessage(req, res, next) {
    try {
        const toValue = String(req.body.to || "");
        const messageText = String(req.body.text || "").trim();

        if (!messageText) {
            return res.status(400).json({
                error: "Digite uma mensagem."
            });
        }

        if (messageText.length > 5000) {
            return res.status(400).json({
                error: "A mensagem é muito grande."
            });
        }

        const target = findUserByID(toValue) || findUserByUsername(toValue);

        if (!target) {
            return res.status(404).json({
                error: "Destinatário não encontrado."
            });
        }

        if (target.id === req.user.id) {
            return res.status(400).json({
                error: "Você não pode enviar mensagem para si mesmo."
            });
        }

        const message = {
            id: crypto.randomUUID(),
            from: req.user.id,
            to: target.id,
            text: messageText,
            createdAt: new Date().toISOString()
        };

        db.messages.push(message);

        await saveDB();

        res.status(201).json({
            success: true,
            message: {
                ...message,
                sender: publicUser(req.user)
            }
        });
    } catch (error) {
        next(error);
    }
}

app.post("/api/messages", requireDatabase, requireAuth, sendMessage);
app.post("/api/messages/send", requireDatabase, requireAuth, sendMessage);

// ======================================================
// CRIAR SERVIDORES
// ======================================================

app.post("/api/servers", requireDatabase, requireAuth, async (req, res, next) => {
    try {
        const name = String(req.body.name || "").trim();

        if (name.length < 2 || name.length > 40) {
            return res.status(400).json({
                error: "O nome do servidor deve ter entre 2 e 40 caracteres."
            });
        }

        const server = {
            id: generateServerID(),
            name,
            owner: req.user.id,
            members: [req.user.id],
            createdAt: new Date().toISOString()
        };

        db.servers.push(server);

        await saveDB();

        res.status(201).json({
            success: true,
            server
        });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// LISTAR SERVIDORES DO USUÁRIO
// ======================================================

app.get("/api/servers", requireDatabase, requireAuth, (req, res) => {
    const servers = db.servers.filter(server =>
        Array.isArray(server.members) &&
        server.members.includes(req.user.id)
    );

    res.json({ servers });
});

// ======================================================
// CRIAR CONVITE
// ======================================================

app.post("/api/servers/:serverId/invites", requireDatabase, requireAuth, async (req, res, next) => {
    try {
        const server = db.servers.find(
            item => item.id === req.params.serverId
        );

        if (!server) {
            return res.status(404).json({
                error: "Servidor não encontrado."
            });
        }

        if (!server.members.includes(req.user.id)) {
            return res.status(403).json({
                error: "Você não pertence a esse servidor."
            });
        }

        const invite = {
            code: generateInviteCode(),
            serverId: server.id,
            createdBy: req.user.id,
            createdAt: new Date().toISOString()
        };

        db.invites.push(invite);

        await saveDB();

        res.status(201).json({
            success: true,
            invite
        });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// ENTRAR EM SERVIDOR COM CONVITE
// ======================================================

app.post("/api/invites/join", requireDatabase, requireAuth, async (req, res, next) => {
    try {
        const code = String(req.body.code || "").trim().toUpperCase();

        const invite = db.invites.find(
            item => item.code === code
        );

        if (!invite) {
            return res.status(404).json({
                error: "Convite inválido."
            });
        }

        const server = db.servers.find(
            item => item.id === invite.serverId
        );

        if (!server) {
            return res.status(404).json({
                error: "Servidor não encontrado."
            });
        }

        if (!server.members.includes(req.user.id)) {
            server.members.push(req.user.id);
        }

        await saveDB();

        res.json({
            success: true,
            server
        });
    } catch (error) {
        next(error);
    }
});

// ======================================================
// ATUALIZAÇÕES
// Endpoint público para não gerar 401 antes do login.
// ======================================================

app.get("/api/updates", requireDatabase, (req, res) => {
    res.json({
        success: true,
        updatedAt: db.updatedAt,
        users: db.users.length,
        servers: db.servers.length
    });
});

// ======================================================
// STATUS DO SERVIDOR
// ======================================================

app.get("/api/status", (req, res) => {
    res.json({
        online: true,
        databaseReady,
        service: "Epic Chat"
    });
});

// ======================================================
// ERROS DE ROTAS
// ======================================================

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "Rota da API não encontrada.",
        route: req.originalUrl
    });
});

app.use((error, req, res, next) => {
    console.error("ERRO NO SERVIDOR:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        error: "Erro interno do servidor."
    });
});

// ======================================================
// INICIAR
// ======================================================

async function startServer() {
    try {
        await loadDB();

        app.listen(PORT, () => {
            console.log("");
            console.log("================================");
            console.log("       EPIC CHAT ONLINE");
            console.log("================================");
            console.log(`Servidor: http://localhost:${PORT}`);
            console.log("Banco: JSONBin conectado");
            console.log(`Contas: ${db.users.length}`);
            console.log("================================");
            console.log("");
        });
    } catch (error) {
        console.error("Não foi possível iniciar o Epic Chat:");
        console.error(error.message);
        process.exit(1);
    }
}

startServer();
