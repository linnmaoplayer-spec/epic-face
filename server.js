
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const BIN_ID = process.env.JSONBIN_BIN_ID;
const ACCESS_KEY = process.env.JSONBIN_ACCESS_KEY;

if (!BIN_ID || !ACCESS_KEY || !process.env.SESSION_SECRET) {
    console.error("ERRO: Configure JSONBIN_BIN_ID, JSONBIN_ACCESS_KEY e SESSION_SECRET.");
    process.exit(1);
}

app.set("trust proxy", 1);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(session({
    name: "epicchat.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// =====================================================
// BANCO DE DADOS JSONBIN
// =====================================================

let db = {
    users: [],
    messages: [],
    servers: [],
    invites: [],
    nextPlayer: 0,
    nextServer: 1,
    updatedAt: null
};

let databaseReady = false;
let saveQueue = Promise.resolve();

async function jsonBinRequest(method, body) {
    const response = await fetch(
        `https://api.jsonbin.io/v3/b/${BIN_ID}${method === "GET" ? "/latest" : ""}`,
        {
            method,
            headers: {
                "Content-Type": "application/json",
                "X-Access-Key": ACCESS_KEY
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        }
    );

    const text = await response.text();

    if (!response.ok) {
        throw new Error(`JSONBin ${response.status}: ${text}`);
    }

    return text ? JSON.parse(text) : {};
}

async function loadDB() {
    console.log("Conectando ao JSONBin...");

    const result = await jsonBinRequest("GET");

    const data = result.record || {};

    // Mantém outros campos que já existam no banco.
    db = {
        ...data,
        users: Array.isArray(data.users) ? data.users : [],
        messages: Array.isArray(data.messages) ? data.messages : [],
        servers: Array.isArray(data.servers) ? data.servers : [],
        invites: Array.isArray(data.invites) ? data.invites : [],
        nextPlayer: Number(data.nextPlayer) || 0,
        nextServer: Number(data.nextServer) || 1
    };

    // Migração de usuários antigos sem ID.
    for (const user of db.users) {
        if (!user.id) {
            user.id = generatePlayerId();
        }

        if (!Array.isArray(user.friends)) {
            user.friends = [];
        }

        if (!user.createdAt) {
            user.createdAt = new Date().toISOString();
        }
    }

    databaseReady = true;

    console.log("Banco de dados carregado.");
    console.log("Contas cadastradas:", db.users.length);

    await saveDB();
}

function saveDB() {
    saveQueue = saveQueue.then(async () => {
        db.updatedAt = new Date().toISOString();
        await jsonBinRequest("PUT", db);
    });

    return saveQueue;
}

// =====================================================
// IDS
// =====================================================

function generatePlayerId() {
    let id;

    do {
        const number = crypto.randomInt(0, 10000000);

        const first = Math.floor(number / 10000);
        const second = Math.floor(number / 10) % 1000;
        const third = number % 10;

        id =
            String(first).padStart(3, "0") + ":" +
            String(second).padStart(3, "0") + "." +
            third;

    } while (db.users.some(user => user.id === id));

    return id;
}

function generateServerId() {
    let id;

    do {
        id = "SRV-" + String(db.nextServer++).padStart(6, "0");
    } while (db.servers.some(server => server.id === id));

    return id;
}

function generateInviteCode() {
    return "EPIC-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

// =====================================================
// FUNÇÕES AUXILIARES
// =====================================================

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
        avatar: user.avatar || null,
        status: user.status || "offline",
        createdAt: user.createdAt
    };
}

function auth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            error: "Você precisa entrar na sua conta."
        });
    }

    const user = db.users.find(u => u.id === req.session.userId);

    if (!user) {
        return req.session.destroy(() => {
            res.status(401).json({ error: "Sessão inválida." });
        });
    }

    req.user = user;
    next();
}

function validUsername(username) {
    return typeof username === "string" &&
        /^[a-zA-Z0-9_]{3,24}$/.test(username);
}

function getServerMember(server, userId) {
    return server.members?.includes(userId);
}

// =====================================================
// ARQUIVOS DO SITE - TODOS NA MESMA PASTA
// =====================================================

// Somente estes arquivos ficam públicos.
// server.js, .env e package.json não são disponibilizados.

const publicFiles = {
    "/epic_chat.html": "epic_chat.html",
    "/epic_chat.css": "epic_chat.css",
    "/epic_chat.js": "epic_chat.js",
    "/icon.png": "icon.png"
};

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "epic_chat.html"));
});

for (const [url, filename] of Object.entries(publicFiles)) {
    app.get(url, (req, res) => {
        const file = path.join(__dirname, filename);

        if (!fs.existsSync(file)) {
            return res.status(404).send("Arquivo não encontrado: " + filename);
        }

        res.sendFile(file);
    });
}

// =====================================================
// CADASTRO
// =====================================================

app.post("/api/register", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!validUsername(username)) {
            return res.status(400).json({
                error: "O usuário deve ter entre 3 e 24 caracteres. Use letras, números e _."
            });
        }

        if (typeof password !== "string" || password.length < 6) {
            return res.status(400).json({
                error: "A senha precisa ter pelo menos 6 caracteres."
            });
        }

        if (findUserByUsername(username)) {
            return res.status(409).json({
                error: "Esse nome de usuário já está em uso."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = {
            id: generatePlayerId(),
            username,
            passwordHash,
            avatar: null,
            friends: [],
            status: "offline",
            createdAt: new Date().toISOString()
        };

        db.users.push(user);

        await saveDB();

        req.session.userId = user.id;

        await new Promise((resolve, reject) => {
            req.session.save(err => err ? reject(err) : resolve());
        });

        res.json({
            success: true,
            user: publicUser(user)
        });

    } catch (error) {
        console.error("ERRO NO CADASTRO:", error);
        res.status(500).json({ error: "Erro interno ao criar conta." });
    }
});

// =====================================================
// LOGIN
// =====================================================

app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                error: "Informe usuário e senha."
            });
        }

        const user = findUserByUsername(username);

        if (!user) {
            return res.status(401).json({
                error: "Usuário ou senha incorretos."
            });
        }

        const storedHash = user.passwordHash || user.password;

        if (!storedHash) {
            return res.status(500).json({
                error: "A conta não possui uma senha válida cadastrada."
            });
        }

        let passwordCorrect = false;

        if (typeof storedHash === "string" && storedHash.startsWith("$2")) {
            passwordCorrect = await bcrypt.compare(password, storedHash);
        } else {
            passwordCorrect = password === storedHash;
        }

        if (!passwordCorrect) {
            return res.status(401).json({
                error: "Usuário ou senha incorretos."
            });
        }

        // Atualiza senhas antigas em texto para hash.
        if (!user.passwordHash) {
            user.passwordHash = await bcrypt.hash(password, 12);
            delete user.password;
            await saveDB();
        }

        req.session.regenerate(async err => {
            if (err) {
                console.error("ERRO NA SESSÃO:", err);
                return res.status(500).json({
                    error: "Não foi possível criar a sessão."
                });
            }

            req.session.userId = user.id;
            user.status = "online";

            try {
                await saveDB();

                req.session.save(saveError => {
                    if (saveError) {
                        console.error("ERRO AO SALVAR SESSÃO:", saveError);
                        return res.status(500).json({
                            error: "Não foi possível salvar a sessão."
                        });
                    }

                    res.json({
                        success: true,
                        user: publicUser(user)
                    });
                });

            } catch (error) {
                console.error("ERRO AO FINALIZAR LOGIN:", error);
                res.status(500).json({
                    error: "Erro ao salvar os dados do login."
                });
            }
        });

    } catch (error) {
        console.error("ERRO NO LOGIN:", error);
        res.status(500).json({
            error: "Erro interno no login."
        });
    }
});

// =====================================================
// SESSÃO / LOGOUT
// =====================================================

app.get("/api/me", auth, (req, res) => {
    res.json({
        success: true,
        user: publicUser(req.user)
    });
});

app.post("/api/logout", auth, (req, res) => {
    req.user.status = "offline";

    saveDB()
        .then(() => {
            req.session.destroy(err => {
                if (err) {
                    return res.status(500).json({
                        error: "Erro ao sair da conta."
                    });
                }

                res.clearCookie("epicchat.sid");
                res.json({ success: true });
            });
        })
        .catch(error => {
            console.error(error);
            res.status(500).json({ error: "Erro ao atualizar conta." });
        });
});

// =====================================================
// PERFIL
// =====================================================

app.patch("/api/profile", auth, async (req, res) => {
    try {
        const { username, avatar } = req.body;

        if (username !== undefined) {
            if (!validUsername(username)) {
                return res.status(400).json({
                    error: "O usuário deve ter entre 3 e 24 caracteres."
                });
            }

            const existing = findUserByUsername(username);

            if (existing && existing.id !== req.user.id) {
                return res.status(409).json({
                    error: "Esse nome já está sendo usado."
                });
            }

            req.user.username = username;
        }

        if (avatar !== undefined) {
            if (avatar !== null && (
                typeof avatar !== "string" ||
                !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(avatar) ||
                avatar.length > 4 * 1024 * 1024
            )) {
                return res.status(400).json({
                    error: "Imagem inválida ou muito grande."
                });
            }

            req.user.avatar = avatar;
        }

        await saveDB();

        res.json({
            success: true,
            user: publicUser(req.user)
        });

    } catch (error) {
        console.error("ERRO NO PERFIL:", error);
        res.status(500).json({ error: "Erro ao atualizar perfil." });
    }
});

// =====================================================
// PESQUISAR USUÁRIOS
// =====================================================

app.get("/api/users/search", auth, (req, res) => {
    const query = String(req.query.q || "").toLowerCase();

    const users = db.users
        .filter(user =>
            user.id !== req.user.id &&
            user.username.toLowerCase().includes(query)
        )
        .slice(0, 30)
        .map(publicUser);

    res.json({ users });
});

// =====================================================
// AMIGOS
// =====================================================

app.get("/api/friends", auth, (req, res) => {
    const friends = req.user.friends
        .map(id => db.users.find(user => user.id === id))
        .filter(Boolean)
        .map(publicUser);

    res.json({ friends });
});

app.post("/api/friends/request", auth, async (req, res) => {
    try {
        const { username, userId } = req.body;

        const target = userId
            ? db.users.find(user => user.id === userId)
            : findUserByUsername(username);

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
        console.error(error);
        res.status(500).json({ error: "Erro ao adicionar amigo." });
    }
});

app.delete("/api/friends/:userId", auth, async (req, res) => {
    req.user.friends = req.user.friends.filter(
        id => id !== req.params.userId
    );

    const target = db.users.find(user => user.id === req.params.userId);

    if (target) {
        target.friends = target.friends.filter(
            id => id !== req.user.id
        );
    }

    await saveDB();

    res.json({ success: true });
});

// =====================================================
// MENSAGENS PRIVADAS
// =====================================================

app.get("/api/messages/:username", auth, (req, res) => {
    const target = findUserByUsername(req.params.username);

    if (!target) {
        return res.status(404).json({
            error: "Usuário não encontrado."
        });
    }

    const messages = db.messages.filter(message =>
        (message.from === req.user.id && message.to === target.id) ||
        (message.from === target.id && message.to === req.user.id)
    );

    res.json({
        messages: messages.map(message => ({
            ...message,
            sender: publicUser(
                db.users.find(user => user.id === message.from)
            )
        }))
    });
});

app.post("/api/messages", auth, async (req, res) => {
    try {
        const { to, username, text } = req.body;

        const target = to
            ? db.users.find(user => user.id === to)
            : findUserByUsername(username);

        if (!target) {
            return res.status(404).json({
                error: "Destinatário não encontrado."
            });
        }

        if (typeof text !== "string" || !text.trim() || text.length > 5000) {
            return res.status(400).json({
                error: "Mensagem inválida."
            });
        }

        const message = {
            id: crypto.randomUUID(),
            from: req.user.id,
            to: target.id,
            text: text.trim(),
            createdAt: new Date().toISOString()
        };

        db.messages.push(message);

        await saveDB();

        res.json({
            success: true,
            message: {
                ...message,
                sender: publicUser(req.user)
            }
        });

    } catch (error) {
        console.error("ERRO AO ENVIAR MENSAGEM:", error);
        res.status(500).json({ error: "Erro ao enviar mensagem." });
    }
});

// Compatibilidade com clientes que usam /api/messages/send.
app.post("/api/messages/send", auth, async (req, res) => {
    const { to, username, text } = req.body;

    const target = to
        ? db.users.find(user => user.id === to)
        : findUserByUsername(username);

    if (!target) {
        return res.status(404).json({ error: "Destinatário não encontrado." });
    }

    if (typeof text !== "string" || !text.trim() || text.length > 5000) {
        return res.status(400).json({ error: "Mensagem inválida." });
    }

    const message = {
        id: crypto.randomUUID(),
        from: req.user.id,
        to: target.id,
        text: text.trim(),
        createdAt: new Date().toISOString()
    };

    db.messages.push(message);

    try {
        await saveDB();
        res.json({ success: true, message });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao salvar mensagem." });
    }
});

// =====================================================
// CRIAR SERVIDORES
// =====================================================

app.post("/api/servers", auth, async (req, res) => {
    try {
        const { name, description } = req.body;

        if (typeof name !== "string" || name.trim().length < 2 || name.length > 40) {
            return res.status(400).json({
                error: "O nome do servidor deve ter entre 2 e 40 caracteres."
            });
        }

        const server = {
            id: generateServerId(),
            name: name.trim(),
            description: typeof description === "string"
                ? description.slice(0, 300)
                : "",
            owner: req.user.id,
            members: [req.user.id],
            createdAt: new Date().toISOString()
        };

        db.servers.push(server);

        await saveDB();

        res.json({
            success: true,
            server
        });

    } catch (error) {
        console.error("ERRO AO CRIAR SERVIDOR:", error);
        res.status(500).json({ error: "Erro ao criar servidor." });
    }
});

// =====================================================
// LISTAR SERVIDORES
// =====================================================

app.get("/api/servers", auth, (req, res) => {
    const servers = db.servers.filter(
        server => getServerMember(server, req.user.id)
    );

    res.json({ servers });
});

// =====================================================
// CONVITES
// =====================================================

app.post("/api/servers/:serverId/invites", auth, async (req, res) => {
    try {
        const server = db.servers.find(
            item => item.id === req.params.serverId
        );

        if (!server) {
            return res.status(404).json({
                error: "Servidor não encontrado."
            });
        }

        if (!getServerMember(server, req.user.id)) {
            return res.status(403).json({
                error: "Você não participa deste servidor."
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

        res.json({
            success: true,
            invite
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao criar convite." });
    }
});

app.post("/api/invites/join", auth, async (req, res) => {
    try {
        const { code } = req.body;

        const invite = db.invites.find(
            item => item.code === String(code || "").toUpperCase()
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
        console.error(error);
        res.status(500).json({ error: "Erro ao entrar no servidor." });
    }
});

// =====================================================
// ATUALIZAÇÕES
// =====================================================

app.get("/api/updates", auth, (req, res) => {
    res.json({
        success: true,
        updatedAt: db.updatedAt,
        user: publicUser(req.user)
    });
});

// =====================================================
// ERROS
// =====================================================

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "Rota da API não encontrada.",
        route: req.originalUrl
    });
});

app.use((error, req, res, next) => {
    console.error("ERRO GERAL:", error);

    if (res.headersSent) return next(error);

    res.status(500).json({
        error: "Erro interno do servidor."
    });
});

// =====================================================
// INICIALIZAÇÃO
// =====================================================

async function startServer() {
    try {
        await loadDB();

        app.listen(PORT, () => {
            console.log("");
            console.log("================================");
            console.log("       EPIC CHAT ONLINE");
            console.log("================================");
            console.log("Porta:", PORT);
            console.log("Arquivos:", __dirname);
            console.log("Contas:", db.users.length);
            console.log("Servidores:", db.servers.length);
            console.log("Banco: JSONBin conectado");
            console.log("================================");
        });

    } catch (error) {
        console.error("");
        console.error("NÃO FOI POSSÍVEL INICIAR O EPIC CHAT");
        console.error(error);
        process.exit(1);
    }
}

startServer();
