
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const BIN_ID = process.env.JSONBIN_BIN_ID;
const ACCESS_KEY = process.env.JSONBIN_ACCESS_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!BIN_ID || !ACCESS_KEY || !SESSION_SECRET) {
    console.error("ERRO: Configure JSONBIN_BIN_ID, JSONBIN_ACCESS_KEY e SESSION_SECRET.");
    process.exit(1);
}

// ======================================================
// CONFIGURAÇÃO
// ======================================================

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

    const responseText = await response.text();

    if (!response.ok) {
        throw new Error(
            `JSONBin retornou ${response.status}: ${responseText}`
        );
    }

    return responseText ? JSON.parse(responseText) : {};
}

async function loadDB() {
    console.log("Conectando ao JSONBin...");

    const result = await jsonBinRequest("GET");
    const data = result.record || {};

    // Preserva campos desconhecidos já existentes no JSONBin.
    db = {
        ...data,
        users: Array.isArray(data.users) ? data.users : [],
        messages: Array.isArray(data.messages) ? data.messages : [],
        servers: Array.isArray(data.servers) ? data.servers : [],
        invites: Array.isArray(data.invites) ? data.invites : [],
        nextPlayer: Number(data.nextPlayer) || 0,
        nextServer: Number(data.nextServer) || 1
    };

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

    for (const server of db.servers) {
        if (!Array.isArray(server.members)) {
            server.members = [];
        }
    }

    databaseReady = true;

    console.log("Banco de dados carregado.");
    console.log("Usuários:", db.users.length);
    console.log("Mensagens:", db.messages.length);
    console.log("Servidores:", db.servers.length);

    await saveDB();
}

function saveDB() {
    saveQueue = saveQueue.then(async () => {
        db.updatedAt = new Date().toISOString();
        await jsonBinRequest("PUT", db);
    });

    return saveQueue;
}

// ======================================================
// IDS
// ======================================================

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

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function findUserByUsername(username) {
    return db.users.find(
        user =>
            user.username.toLowerCase() ===
            String(username).toLowerCase()
    );
}

function findUserById(id) {
    return db.users.find(user => user.id === id);
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

function validUsername(username) {
    return (
        typeof username === "string" &&
        /^[a-zA-Z0-9_]{3,24}$/.test(username)
    );
}

function auth(req, res, next) {
    if (!databaseReady) {
        return res.status(503).json({
            error: "Banco de dados ainda não está pronto."
        });
    }

    if (!req.session.userId) {
        return res.status(401).json({
            error: "Você precisa entrar na sua conta."
        });
    }

    const user = findUserById(req.session.userId);

    if (!user) {
        return req.session.destroy(() => {
            res.status(401).json({
                error: "Sessão inválida."
            });
        });
    }

    req.user = user;
    next();
}

function serverMember(server, userId) {
    return server.members.includes(userId);
}

// ======================================================
// ARQUIVOS NA MESMA PASTA DO SERVER.JS
// ======================================================

// Somente arquivos públicos são disponibilizados.
// O .env e o próprio server.js não são expostos.

const files = {
    "/epic_chat.html": "epic_chat.html",
    "/epic_chat.css": "epic_chat.css",
    "/epic_chat.js": "epic_chat.js",
    "/icon.png": "icon.png"
};

app.get("/", (req, res) => {
    const file = path.join(__dirname, "epic_chat.html");

    if (!fs.existsSync(file)) {
        return res.status(404).send("epic_chat.html não encontrado.");
    }

    res.sendFile(file);
});

for (const [url, filename] of Object.entries(files)) {
    app.get(url, (req, res) => {
        const file = path.join(__dirname, filename);

        if (!fs.existsSync(file)) {
            return res.status(404).send(
                "Arquivo não encontrado: " + filename
            );
        }

        res.sendFile(file);
    });
}

// ======================================================
// CADASTRO
// ======================================================

app.post("/api/register", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!validUsername(username)) {
            return res.status(400).json({
                error: "O usuário precisa ter de 3 a 24 caracteres. Use letras, números e _."
            });
        }

        if (
            typeof password !== "string" ||
            password.length < 6 ||
            password.length > 128
        ) {
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

        const user = {
            id: generatePlayerId(),
            username,
            passwordHash,
            avatar: null,
            friends: [],
            status: "online",
            createdAt: new Date().toISOString()
        };

        db.users.push(user);

        await saveDB();

        req.session.regenerate(err => {
            if (err) {
                console.error("ERRO NA SESSÃO:", err);
                return res.status(500).json({
                    error: "Não foi possível criar sua sessão."
                });
            }

            req.session.userId = user.id;

            req.session.save(saveError => {
                if (saveError) {
                    console.error(saveError);
                    return res.status(500).json({
                        error: "Não foi possível salvar sua sessão."
                    });
                }

                res.json({
                    success: true,
                    user: publicUser(user)
                });
            });
        });

    } catch (error) {
        console.error("ERRO NO CADASTRO:", error);

        res.status(500).json({
            error: "Erro interno ao criar conta."
        });
    }
});

// ======================================================
// LOGIN
// ======================================================

app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            !username ||
            !password
        ) {
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

        const storedPassword = user.passwordHash || user.password;

        if (typeof storedPassword !== "string") {
            return res.status(500).json({
                error: "A conta não possui uma senha válida."
            });
        }

        let passwordCorrect = false;

        if (storedPassword.startsWith("$2")) {
            passwordCorrect = await bcrypt.compare(
                password,
                storedPassword
            );
        } else {
            passwordCorrect = password === storedPassword;
        }

        if (!passwordCorrect) {
            return res.status(401).json({
                error: "Usuário ou senha incorretos."
            });
        }

        // Converte senhas antigas para hash.
        if (!user.passwordHash) {
            user.passwordHash = await bcrypt.hash(password, 12);
            delete user.password;
        }

        req.session.regenerate(err => {
            if (err) {
                console.error("ERRO AO REGENERAR SESSÃO:", err);

                return res.status(500).json({
                    error: "Não foi possível iniciar a sessão."
                });
            }

            req.session.userId = user.id;
            user.status = "online";

            saveDB()
                .then(() => {
                    req.session.save(saveError => {
                        if (saveError) {
                            console.error(
                                "ERRO AO SALVAR SESSÃO:",
                                saveError
                            );

                            return res.status(500).json({
                                error: "Não foi possível salvar a sessão."
                            });
                        }

                        res.json({
                            success: true,
                            user: publicUser(user)
                        });
                    });
                })
                .catch(error => {
                    console.error("ERRO AO SALVAR LOGIN:", error);

                    res.status(500).json({
                        error: "Erro ao salvar os dados do login."
                    });
                });
        });

    } catch (error) {
        console.error("ERRO NO LOGIN:", error);

        res.status(500).json({
            error: "Erro interno no login."
        });
    }
});

// ======================================================
// SESSÃO
// ======================================================

app.get("/api/me", auth, (req, res) => {
    res.json({
        success: true,
        user: publicUser(req.user)
    });
});

app.post("/api/logout", auth, async (req, res) => {
    try {
        req.user.status = "offline";
        await saveDB();

        req.session.destroy(err => {
            if (err) {
                return res.status(500).json({
                    error: "Erro ao sair da conta."
                });
            }

            res.clearCookie("epicchat.sid", {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax"
            });

            res.json({ success: true });
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Erro ao encerrar a sessão."
        });
    }
});

// ======================================================
// PESQUISA POR NOME E ID
// ======================================================

app.get("/api/users/search", auth, (req, res) => {
    const query = String(req.query.q || "").toLowerCase().trim();

    if (!query) {
        return res.json({ users: [] });
    }

    const users = db.users
        .filter(user =>
            user.id !== req.user.id &&
            (
                user.username.toLowerCase().includes(query) ||
                user.id.toLowerCase().includes(query)
            )
        )
        .slice(0, 30)
        .map(publicUser);

    res.json({ users });
});

// ======================================================
// PERFIL
// ======================================================

app.patch("/api/profile", auth, async (req, res) => {
    try {
        const { username, avatar } = req.body;

        if (username !== undefined) {
            if (!validUsername(username)) {
                return res.status(400).json({
                    error: "O nome precisa ter entre 3 e 24 caracteres."
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
            if (
                avatar !== null &&
                (
                    typeof avatar !== "string" ||
                    !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(avatar) ||
                    avatar.length > 4 * 1024 * 1024
                )
            ) {
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

        res.status(500).json({
            error: "Erro ao atualizar perfil."
        });
    }
});

// ======================================================
// AMIGOS
// ======================================================

app.get("/api/friends", auth, (req, res) => {
    const friends = req.user.friends
        .map(id => findUserById(id))
        .filter(Boolean)
        .map(publicUser);

    res.json({ friends });
});

app.post("/api/friends/request", auth, async (req, res) => {
    try {
        const { username, userId } = req.body;

        const target = userId
            ? findUserById(userId)
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

        res.status(500).json({
            error: "Erro ao adicionar amigo."
        });
    }
});

app.delete("/api/friends/:userId", auth, async (req, res) => {
    try {
        const target = findUserById(req.params.userId);

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
        console.error(error);

        res.status(500).json({
            error: "Erro ao remover amigo."
        });
    }
});

// ======================================================
// CARREGAR MENSAGENS
// ======================================================

app.get("/api/messages/:username", auth, (req, res) => {
    const target = findUserByUsername(req.params.username);

    if (!target) {
        return res.status(404).json({
            error: "Usuário não encontrado."
        });
    }

    const messages = db.messages
        .filter(message =>
            (
                message.from === req.user.id &&
                message.to === target.id
            ) ||
            (
                message.from === target.id &&
                message.to === req.user.id
            )
        )
        .map(message => ({
            ...message,
            sender: publicUser(findUserById(message.from))
        }));

    res.json({ messages });
});

// ======================================================
// ENVIAR MENSAGENS
// ======================================================

async function sendPrivateMessage(req, res) {
    try {
        const { to, username, text } = req.body;

        const target = to
            ? findUserById(to)
            : findUserByUsername(username);

        if (!target) {
            return res.status(404).json({
                error: "Destinatário não encontrado."
            });
        }

        if (target.id === req.user.id) {
            return res.status(400).json({
                error: "Não é possível enviar mensagem para si mesmo."
            });
        }

        if (
            typeof text !== "string" ||
            !text.trim() ||
            text.length > 5000
        ) {
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

        res.status(500).json({
            error: "Erro ao enviar mensagem."
        });
    }
}

app.post("/api/messages", auth, sendPrivateMessage);
app.post("/api/messages/send", auth, sendPrivateMessage);

// ======================================================
// SERVIDORES
// ======================================================

app.post("/api/servers", auth, async (req, res) => {
    try {
        const { name, description } = req.body;

        if (
            typeof name !== "string" ||
            name.trim().length < 2 ||
            name.trim().length > 40
        ) {
            return res.status(400).json({
                error: "O nome deve ter entre 2 e 40 caracteres."
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
        console.error(error);

        res.status(500).json({
            error: "Erro ao criar servidor."
        });
    }
});

app.get("/api/servers", auth, (req, res) => {
    const servers = db.servers.filter(
        server => serverMember(server, req.user.id)
    );

    res.json({ servers });
});

// ======================================================
// CONVITES
// ======================================================

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

        if (!serverMember(server, req.user.id)) {
            return res.status(403).json({
                error: "Você não participa desse servidor."
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

        res.status(500).json({
            error: "Erro ao criar convite."
        });
    }
});

app.post("/api/invites/join", auth, async (req, res) => {
    try {
        const code = String(req.body.code || "").toUpperCase();

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
        console.error(error);

        res.status(500).json({
            error: "Erro ao entrar no servidor."
        });
    }
});

// ======================================================
// ATUALIZAÇÕES
// ======================================================

app.get("/api/updates", auth, (req, res) => {
    res.json({
        success: true,
        updatedAt: db.updatedAt,
        user: publicUser(req.user)
    });
});

// ======================================================
// ROTAS NÃO ENCONTRADAS
// ======================================================

app.use("/api", (req, res) => {
    res.status(404).json({
        error: "Rota não encontrada.",
        route: req.originalUrl
    });
});

app.use((error, req, res, next) => {
    console.error("ERRO GERAL:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        error: "Erro interno do servidor."
    });
});

// ======================================================
// INICIAR SERVIDOR
// ======================================================

async function startServer() {
    try {
        await loadDB();

        app.listen(PORT, () => {
            console.log("");
            console.log("==================================");
            console.log("          EPIC CHAT ONLINE");
            console.log("==================================");
            console.log("Endereço: http://localhost:" + PORT);
            console.log("Arquivos:", __dirname);
            console.log("Usuários:", db.users.length);
            console.log("Mensagens:", db.messages.length);
            console.log("Servidores:", db.servers.length);
            console.log("JSONBin conectado.");
            console.log("==================================");
        });

    } catch (error) {
        console.error("");
        console.error("FALHA AO INICIAR O EPIC CHAT:");
        console.error(error);
        process.exit(1);
    }
}

startServer();
