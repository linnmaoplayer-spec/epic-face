
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const BIN_ID = process.env.JSONBIN_BIN_ID;
const ACCESS_KEY = process.env.JSONBIN_ACCESS_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!BIN_ID || !ACCESS_KEY || !SESSION_SECRET) {
    console.error("ERRO: Configure JSONBIN_BIN_ID, JSONBIN_ACCESS_KEY e SESSION_SECRET.");
    process.exit(1);
}

const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

app.set("trust proxy", 1);

app.use(express.json({ limit: "500kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    name: "epicchat.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

app.use(express.static(path.join(__dirname, "public")));

let db = {
    users: [],
    messages: [],
    servers: [],
    invites: [],
    nextPlayer: 1,
    nextServer: 1
};

let writeQueue = Promise.resolve();

async function loadDB() {
    const response = await fetch(`${BIN_URL}/latest`, {
        headers: {
            "X-Access-Key": ACCESS_KEY
        }
    });

    if (!response.ok) {
        throw new Error("Erro ao carregar JSONBin: " + response.status);
    }

    const result = await response.json();
    const data = result.record || {};

    db = {
        users: Array.isArray(data.users) ? data.users : [],
        messages: Array.isArray(data.messages) ? data.messages : [],
        servers: Array.isArray(data.servers) ? data.servers : [],
        invites: Array.isArray(data.invites) ? data.invites : [],
        nextPlayer: Number(data.nextPlayer) || 1,
        nextServer: Number(data.nextServer) || 1
    };

    // Migração dos usuários antigos.
    for (const user of db.users) {
        if (!user.id) {
            user.id = generatePlayerId();
        }

        user.friends ||= [];
        user.avatar ??= null;
    }

    for (const server of db.servers) {
        server.members ||= [];
    }

    console.log("Banco de dados carregado.");
    console.log("Contas cadastradas:", db.users.length);
}

async function saveDB() {
    const operation = writeQueue.then(async () => {
        const response = await fetch(BIN_URL, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "X-Access-Key": ACCESS_KEY
            },
            body: JSON.stringify(db)
        });

        if (!response.ok) {
            throw new Error("Erro ao salvar JSONBin: " + response.status);
        }

        return true;
    });

    writeQueue = operation.catch(error => {
        console.error("Erro na fila de gravação:", error);
    });

    return operation;
}

function generatePlayerId() {
    const max = 10000000;

    for (let attempts = 0; attempts < max; attempts++) {
        const n = db.nextPlayer++ % max;

        const a = Math.floor(n / 10000);
        const b = Math.floor(n / 10) % 1000;
        const c = n % 10;

        const id =
            `${String(a).padStart(3, "0")}:` +
            `${String(b).padStart(3, "0")}.` +
            `${c}`;

        if (!db.users.some(user => user.id === id)) {
            return id;
        }
    }

    throw new Error("Não há mais IDs disponíveis.");
}

function generateServerId() {
    let id;

    do {
        id = "SRV-" + String(db.nextServer++).padStart(6, "0");
    } while (db.servers.some(server => server.id === id));

    return id;
}

function generateInviteCode() {
    let code;

    do {
        code = "EPIC-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    } while (db.invites.some(invite => invite.code === code));

    return code;
}

function auth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            error: "Você precisa fazer login."
        });
    }

    next();
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        avatar: user.avatar || null,
        friends: user.friends || []
    };
}

function getUser(req) {
    return db.users.find(user => user.id === req.session.userId);
}

function validUsername(username) {
    return typeof username === "string" &&
        /^[a-zA-Z0-9_.-]{3,24}$/.test(username);
}

function handleError(res, error) {
    console.error(error);
    res.status(500).json({
        error: "Erro interno do servidor."
    });
}

// HOME
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "epic_chat.html"));
});

app.get("/epic_chat.html", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "epic_chat.html"));
});

// STATUS
app.get("/api/status", (req, res) => {
    res.json({
        online: true,
        users: db.users.length,
        servers: db.servers.length
    });
});

// REGISTER
app.post("/api/register", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        if (!validUsername(username)) {
            return res.status(400).json({
                error: "Nome: 3 a 24 caracteres. Use letras, números, ponto, hífen ou underline."
            });
        }

        if (password.length < 6 || password.length > 100) {
            return res.status(400).json({
                error: "A senha precisa ter entre 6 e 100 caracteres."
            });
        }

        if (db.users.some(user =>
            user.username.toLowerCase() === username.toLowerCase()
        )) {
            return res.status(409).json({
                error: "Esse nome já está sendo usado."
            });
        }

        const user = {
            id: generatePlayerId(),
            username,
            password: await bcrypt.hash(password, 12),
            avatar: null,
            friends: [],
            createdAt: Date.now()
        };

        db.users.push(user);
        await saveDB();

        req.session.userId = user.id;

        req.session.save(error => {
            if (error) return handleError(res, error);

            res.json({
                success: true,
                user: publicUser(user)
            });
        });
    } catch (error) {
        handleError(res, error);
    }
});

// LOGIN
app.post("/api/login", async (req, res) => {
    try {
        const username = String(req.body.username || "").trim();
        const password = String(req.body.password || "");

        const user = db.users.find(item =>
            item.username.toLowerCase() === username.toLowerCase()
        );

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({
                error: "Usuário ou senha incorretos."
            });
        }

        req.session.regenerate(error => {
            if (error) return handleError(res, error);

            req.session.userId = user.id;

            req.session.save(error => {
                if (error) return handleError(res, error);

                res.json({
                    success: true,
                    user: publicUser(user)
                });
            });
        });
    } catch (error) {
        handleError(res, error);
    }
});

// CURRENT USER
app.get("/api/me", auth, (req, res) => {
    const user = getUser(req);

    if (!user) {
        return res.status(404).json({
            error: "Jogador não encontrado."
        });
    }

    res.json({
        user: publicUser(user)
    });
});

// LOGOUT
app.post("/api/logout", auth, (req, res) => {
    req.session.destroy(error => {
        if (error) return handleError(res, error);

        res.clearCookie("epicchat.sid", {
            httpOnly: true,
            secure: true,
            sameSite: "lax"
        });

        res.json({ success: true });
    });
});

// PROFILE
app.patch("/api/profile", auth, async (req, res) => {
    try {
        const user = getUser(req);

        if (!user) {
            return res.status(404).json({
                error: "Jogador não encontrado."
            });
        }

        if (req.body.username !== undefined) {
            const username = String(req.body.username).trim();

            if (!validUsername(username)) {
                return res.status(400).json({
                    error: "Nome precisa ter de 3 a 24 caracteres."
                });
            }

            if (db.users.some(other =>
                other.id !== user.id &&
                other.username.toLowerCase() === username.toLowerCase()
            )) {
                return res.status(409).json({
                    error: "Esse nome já está em uso."
                });
            }

            user.username = username;
        }

        if (req.body.avatar !== undefined) {
            const avatar = req.body.avatar;

            if (avatar !== null) {
                if (
                    typeof avatar !== "string" ||
                    avatar.length > 350000 ||
                    !/^data:image\/(png|jpeg|webp|gif);base64,/.test(avatar)
                ) {
                    return res.status(400).json({
                        error: "Imagem inválida ou muito grande."
                    });
                }
            }

            user.avatar = avatar;
        }

        await saveDB();

        res.json({
            success: true,
            user: publicUser(user)
        });
    } catch (error) {
        handleError(res, error);
    }
});

// USER SEARCH
app.get("/api/users/search", auth, (req, res) => {
    const q = String(req.query.q || "").toLowerCase().trim();

    const users = db.users
        .filter(user =>
            user.id !== req.session.userId &&
            (user.username.toLowerCase().includes(q) ||
                user.id.toLowerCase().includes(q))
        )
        .slice(0, 20)
        .map(publicUser);

    res.json({ users });
});

// FRIENDS
app.get("/api/friends", auth, (req, res) => {
    const user = getUser(req);

    if (!user) {
        return res.status(404).json({
            error: "Jogador não encontrado."
        });
    }

    const friends = (user.friends || [])
        .map(id => db.users.find(friend => friend.id === id))
        .filter(Boolean)
        .map(publicUser);

    res.json({ friends });
});

app.post("/api/friends", auth, async (req, res) => {
    try {
        const user = getUser(req);
        const friendId = String(req.body.id || "").trim();

        const friend = db.users.find(item => item.id === friendId);

        if (!friend || friend.id === user.id) {
            return res.status(404).json({
                error: "Jogador não encontrado."
            });
        }

        user.friends ||= [];
        friend.friends ||= [];

        if (!user.friends.includes(friend.id)) {
            user.friends.push(friend.id);
        }

        if (!friend.friends.includes(user.id)) {
            friend.friends.push(user.id);
        }

        await saveDB();

        res.json({
            success: true,
            friend: publicUser(friend)
        });
    } catch (error) {
        handleError(res, error);
    }
});

app.post("/api/friends/request", auth, async (req, res) => {
    req.body.id = req.body.id || req.body.userId;

    const user = getUser(req);
    const friend = db.users.find(item => item.id === req.body.id);

    if (!friend || friend.id === user.id) {
        return res.status(404).json({
            error: "Jogador não encontrado."
        });
    }

    user.friends ||= [];
    friend.friends ||= [];

    if (!user.friends.includes(friend.id)) {
        user.friends.push(friend.id);
    }

    if (!friend.friends.includes(user.id)) {
        friend.friends.push(user.id);
    }

    try {
        await saveDB();
        res.json({ success: true });
    } catch (error) {
        handleError(res, error);
    }
});

app.delete("/api/friends/:id", auth, async (req, res) => {
    try {
        const user = getUser(req);
        const friendId = req.params.id;

        user.friends = (user.friends || []).filter(id => id !== friendId);

        const friend = db.users.find(item => item.id === friendId);

        if (friend) {
            friend.friends = (friend.friends || [])
                .filter(id => id !== user.id);
        }

        await saveDB();

        res.json({ success: true });
    } catch (error) {
        handleError(res, error);
    }
});

// PRIVATE MESSAGES
app.get("/api/messages/:friendId", auth, (req, res) => {
    const user = getUser(req);
    const friendId = req.params.friendId;

    if (!(user.friends || []).includes(friendId)) {
        return res.status(403).json({
            error: "Esse jogador não está na sua lista de amigos."
        });
    }

    const messages = db.messages.filter(message =>
        (message.from === user.id && message.to === friendId) ||
        (message.from === friendId && message.to === user.id)
    );

    res.json({ messages });
});

app.post("/api/messages", auth, async (req, res) => {
    try {
        const user = getUser(req);
        const to = String(req.body.to || "");
        const text = String(req.body.text || "").trim();

        if (!text || text.length > 3000) {
            return res.status(400).json({
                error: "Mensagem vazia ou muito grande."
            });
        }

        if (!(user.friends || []).includes(to)) {
            return res.status(403).json({
                error: "Você precisa ser amigo desse jogador."
            });
        }

        const message = {
            id: crypto.randomUUID(),
            from: user.id,
            to,
            text,
            createdAt: Date.now()
        };

        db.messages.push(message);
        await saveDB();

        res.json({
            success: true,
            message
        });
    } catch (error) {
        handleError(res, error);
    }
});

// SERVERS
app.get("/api/servers", auth, (req, res) => {
    const user = getUser(req);

    const servers = db.servers.filter(server =>
        server.owner === user.id ||
        (server.members || []).includes(user.id)
    );

    res.json({ servers });
});

app.post("/api/servers", auth, async (req, res) => {
    try {
        const user = getUser(req);
        const name = String(req.body.name || "").trim();

        if (name.length < 2 || name.length > 40) {
            return res.status(400).json({
                error: "Nome do servidor precisa ter de 2 a 40 caracteres."
            });
        }

        const server = {
            id: generateServerId(),
            name,
            owner: user.id,
            members: [],
            createdAt: Date.now()
        };

        db.servers.push(server);
        await saveDB();

        res.json({
            success: true,
            server
        });
    } catch (error) {
        handleError(res, error);
    }
});

app.get("/api/servers/:id", auth, (req, res) => {
    const user = getUser(req);

    const server = db.servers.find(item =>
        item.id === req.params.id
    );

    if (!server) {
        return res.status(404).json({
            error: "Servidor não encontrado."
        });
    }

    if (
        server.owner !== user.id &&
        !(server.members || []).includes(user.id)
    ) {
        return res.status(403).json({
            error: "Você não faz parte desse servidor."
        });
    }

    res.json({ server });
});

// CREATE INVITE
app.post("/api/servers/:id/invites", auth, async (req, res) => {
    try {
        const user = getUser(req);

        const server = db.servers.find(item =>
            item.id === req.params.id
        );

        if (!server) {
            return res.status(404).json({
                error: "Servidor não encontrado."
            });
        }

        if (
            server.owner !== user.id &&
            !(server.members || []).includes(user.id)
        ) {
            return res.status(403).json({
                error: "Você não pode criar convites para esse servidor."
            });
        }

        const invite = {
            code: generateInviteCode(),
            serverId: server.id,
            createdBy: user.id,
            createdAt: Date.now()
        };

        db.invites.push(invite);
        await saveDB();

        res.json({
            success: true,
            invite
        });
    } catch (error) {
        handleError(res, error);
    }
});

// JOIN INVITE
app.post("/api/invites/join", auth, async (req, res) => {
    try {
        const user = getUser(req);
        const code = String(req.body.code || "")
            .trim()
            .toUpperCase();

        const invite = db.invites.find(item =>
            item.code.toUpperCase() === code
        );

        if (!invite) {
            return res.status(404).json({
                error: "Convite inválido."
            });
        }

        const server = db.servers.find(item =>
            item.id === invite.serverId
        );

        if (!server) {
            return res.status(404).json({
                error: "Servidor não encontrado."
            });
        }

        server.members ||= [];

        if (
            server.owner !== user.id &&
            !server.members.includes(user.id)
        ) {
            server.members.push(user.id);
            await saveDB();
        }

        res.json({
            success: true,
            server
        });
    } catch (error) {
        handleError(res, error);
    }
});

// UPDATES
app.get("/api/updates", auth, (req, res) => {
    const user = getUser(req);

    if (!user) {
        return res.status(404).json({
            error: "Jogador não encontrado."
        });
    }

    res.json({
        success: true,
        updatedAt: Date.now(),
        user: publicUser(user)
    });
});

// 404 API
app.use("/api", (req, res) => {
    res.status(404).json({
        error: "Rota da API não encontrada."
    });
});

// ERROR HANDLER
app.use((error, req, res, next) => {
    console.error("Erro:", error);

    if (res.headersSent) return next(error);

    res.status(500).json({
        error: "Erro interno do servidor."
    });
});

// START
async function start() {
    try {
        console.log("Conectando ao JSONBin...");

        await loadDB();

        app.listen(PORT, "0.0.0.0", () => {
            console.log("================================");
            console.log("EPIC CHAT ONLINE");
            console.log("Porta:", PORT);
            console.log("Banco: JSONBin conectado");
            console.log("================================");
        });
    } catch (error) {
        console.error("Falha ao iniciar:", error);
        process.exit(1);
    }
}

start();
