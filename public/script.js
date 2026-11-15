
"use strict";

const API = "/api";

let currentUser = null;
let activeUser = null;
let messagesTimer = null;
let searchTimer = null;
let isLoadingMessages = false;

const $ = (id) => document.getElementById(id);

function show(element) {
    if (element) element.classList.remove("hidden");
}

function hide(element) {
    if (element) element.classList.add("hidden");
}

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value ?? "";
}

function setImage(id, value) {
    const element = $(id);
    if (element) {
        element.src = value || "/icon.png";
    }
}

async function api(endpoint, options = {}) {
    const config = {
        method: options.method || "GET",
        credentials: "include",
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        },
        ...(options.body
            ? { body: JSON.stringify(options.body) }
            : {})
    };

    const response = await fetch(API + endpoint, config);

    let data = {};

    try {
        data = await response.json();
    } catch {
        data = {};
    }

    if (response.status === 401) {
        currentUser = null;
        activeUser = null;
        stopPolling();
        throw new Error("Sua sessão expirou. Entre novamente.");
    }

    if (!response.ok) {
        throw new Error(data.error || data.message || `Erro ${response.status}`);
    }

    return data;
}

function notify(message) {
    alert(message);
}

function stopPolling() {
    if (messagesTimer) {
        clearInterval(messagesTimer);
        messagesTimer = null;
    }
}

function startPolling() {
    stopPolling();

    messagesTimer = setInterval(async () => {
        if (!currentUser) return;

        try {
            await refreshAll();
        } catch (error) {
            console.error("Erro ao atualizar:", error);
        }
    }, 5000);
}

// ===============================
// LOGIN E CADASTRO
// ===============================

async function login(username, password) {
    const data = await api("/login", {
        method: "POST",
        body: { username, password }
    });

    currentUser = data.user || data;

    await startApp();
}

async function register(username, password) {
    const data = await api("/register", {
        method: "POST",
        body: { username, password }
    });

    currentUser = data.user || data;

    await startApp();
}

function setupAuthentication() {
    $("loginForm")?.addEventListener("submit", async (event) => {
        event.preventDefault();

        const username = $("loginUsername")?.value.trim();
        const password = $("loginPassword")?.value;

        if (!username || !password) {
            return notify("Preencha todos os campos.");
        }

        try {
            await login(username, password);
        } catch (error) {
            notify(error.message);
        }
    });

    $("registerForm")?.addEventListener("submit", async (event) => {
        event.preventDefault();

        const username = $("registerUsername")?.value.trim();
        const password = $("registerPassword")?.value;

        if (!username || !password) {
            return notify("Preencha todos os campos.");
        }

        if (username.length < 3 || username.length > 24) {
            return notify("O nome precisa ter entre 3 e 24 caracteres.");
        }

        if (password.length < 6) {
            return notify("A senha precisa ter pelo menos 6 caracteres.");
        }

        try {
            await register(username, password);
        } catch (error) {
            notify(error.message);
        }
    });

    $("showRegister")?.addEventListener("click", () => {
        hide($("loginScreen"));
        show($("registerScreen"));
    });

    $("showLogin")?.addEventListener("click", () => {
        hide($("registerScreen"));
        show($("loginScreen"));
    });
}

// ===============================
// INICIALIZAÇÃO
// ===============================

async function startApp() {
    if (!currentUser) return;

    hide($("loginScreen"));
    hide($("registerScreen"));
    show($("appScreen"));

    updateProfileUI();

    try {
        await refreshAll();
        startPolling();
    } catch (error) {
        console.error(error);
    }
}

async function initialize() {
    setupAuthentication();
    setupChat();
    setupSearch();
    setupProfile();

    try {
        const data = await api("/me");

        currentUser = data.user || data;

        await startApp();
    } catch (error) {
        currentUser = null;

        stopPolling();

        show($("loginScreen"));
        hide($("registerScreen"));
        hide($("appScreen"));

        if (error.message.includes("expirou")) {
            console.warn(error.message);
        }
    }
}

// ===============================
// PERFIL
// ===============================

function updateProfileUI() {
    if (!currentUser) return;

    setText("currentUsername", currentUser.username);
    setText("currentPlayerId", currentUser.id);

    setImage("currentAvatar", currentUser.avatar);
}

function setupProfile() {
    $("profileButton")?.addEventListener("click", () => {
        if (!currentUser) return;

        if ($("profileUsername")) {
            $("profileUsername").value = currentUser.username || "";
        }

        setImage("profilePreview", currentUser.avatar);

        show($("profileModal"));
    });

    $("closeProfileModal")?.addEventListener("click", () => {
        hide($("profileModal"));
    });

    $("profileAvatarInput")?.addEventListener("change", (event) => {
        const file = event.target.files?.[0];

        if (!file) return;

        if (!file.type.startsWith("image/")) {
            return notify("Selecione uma imagem válida.");
        }

        if (file.size > 4 * 1024 * 1024) {
            return notify("A imagem deve ter no máximo 4 MB.");
        }

        const reader = new FileReader();

        reader.onload = () => {
            setImage("profilePreview", reader.result);
        };

        reader.readAsDataURL(file);
    });

    $("profileForm")?.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (!currentUser) return;

        const username = $("profileUsername")?.value.trim();

        if (!username || username.length < 3 || username.length > 24) {
            return notify("O nome precisa ter entre 3 e 24 caracteres.");
        }

        let avatar = currentUser.avatar || "";

        const file = $("profileAvatarInput")?.files?.[0];

        if (file) {
            avatar = await new Promise((resolve, reject) => {
                const reader = new FileReader();

                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;

                reader.readAsDataURL(file);
            });
        }

        try {
            const data = await api("/profile", {
                method: "PATCH",
                body: { username, avatar }
            });

            currentUser = data.user || data;

            updateProfileUI();
            hide($("profileModal"));

            notify("Perfil atualizado!");
        } catch (error) {
            notify(error.message);
        }
    });
}

// ===============================
// PESQUISA DE USUÁRIOS
// ===============================

function setupSearch() {
    $("searchInput")?.addEventListener("input", () => {
        clearTimeout(searchTimer);

        const query = $("searchInput").value.trim();

        if (!query) {
            $("searchResults")?.replaceChildren();
            return;
        }

        searchTimer = setTimeout(() => {
            searchUsers(query);
        }, 350);
    });
}

async function searchUsers(query) {
    if (!currentUser) return;

    const results = $("searchResults");

    if (!results) return;

    try {
        const data = await api(
            "/users/search?q=" + encodeURIComponent(query)
        );

        results.replaceChildren();

        const users = data.users || [];

        if (users.length === 0) {
            results.textContent = "Nenhum usuário encontrado.";
            return;
        }

        users.forEach((user) => {
            if (user.id === currentUser.id) return;

            const item = document.createElement("button");
            item.type = "button";
            item.className = "search-result";

            const avatar = document.createElement("img");
            avatar.src = user.avatar || "/icon.png";
            avatar.alt = "";

            const details = document.createElement("span");

            const name = document.createElement("strong");
            name.textContent = user.username;

            const id = document.createElement("small");
            id.textContent = user.id;

            details.append(name, id);
            item.append(avatar, details);

            item.addEventListener("click", () => {
                openChat(user);
            });

            results.appendChild(item);
        });
    } catch (error) {
        console.error("Erro na pesquisa:", error);
    }
}

// ===============================
// AMIGOS
// ===============================

async function loadFriends() {
    if (!currentUser) return;

    const container = $("friendsList");

    if (!container) return;

    const data = await api("/friends");
    const friends = data.friends || [];

    container.replaceChildren();

    if (friends.length === 0) {
        container.textContent = "Você ainda não tem amigos.";
        return;
    }

    friends.forEach((friend) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "friend-item";

        const avatar = document.createElement("img");
        avatar.src = friend.avatar || "/icon.png";
        avatar.alt = "";

        const name = document.createElement("span");
        name.textContent = friend.username;

        item.append(avatar, name);

        item.addEventListener("click", () => {
            openChat(friend);
        });

        container.appendChild(item);
    });
}

async function addFriend(userId) {
    try {
        await api("/friends/request", {
            method: "POST",
            body: { userId }
        });

        await loadFriends();

        notify("Usuário adicionado aos amigos.");
    } catch (error) {
        notify(error.message);
    }
}

// ===============================
// CHAT
// ===============================

function setupChat() {
    $("sendButton")?.addEventListener("click", sendMessage);

    $("messageInput")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    $("logoutButton")?.addEventListener("click", logout);
}

async function openChat(user) {
    if (!user || !user.username) return;

    activeUser = user;

    hide($("emptyChat"));
    show($("activeChat"));

    setText("chatUsername", user.username);
    setText("chatId", user.id);

    setImage("chatAvatar", user.avatar);

    if ($("messageInput")) {
        $("messageInput").disabled = false;
        $("messageInput").focus();
    }

    await loadMessages();
}

async function loadMessages() {
    if (!activeUser || !currentUser || isLoadingMessages) return;

    isLoadingMessages = true;

    try {
        const data = await api(
            "/messages/" + encodeURIComponent(activeUser.username)
        );

        renderMessages(data.messages || []);
    } catch (error) {
        console.error("Erro ao carregar mensagens:", error);
    } finally {
        isLoadingMessages = false;
    }
}

function renderMessages(messages) {
    const container = $("messagesList");

    if (!container) return;

    const oldScroll =
        container.scrollHeight - container.scrollTop - container.clientHeight;

    container.replaceChildren();

    messages.forEach((message) => {
        const mine = message.from === currentUser.id;

        const item = document.createElement("div");
        item.className = mine ? "message mine" : "message";

        const avatar = document.createElement("img");
        avatar.className = "message-avatar";
        avatar.src = message.sender?.avatar || "/icon.png";
        avatar.alt = "";

        const content = document.createElement("div");
        content.className = "message-content";

        const author = document.createElement("strong");
        author.textContent = mine
            ? "Você"
            : (message.sender?.username || activeUser.username);

        const text = document.createElement("p");
        text.textContent = message.text;

        const time = document.createElement("small");

        if (message.createdAt) {
            const date = new Date(message.createdAt);

            time.textContent = date.toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit"
            });
        }

        content.append(author, text, time);
        item.append(avatar, content);

        container.appendChild(item);
    });

    if (oldScroll < 100) {
        container.scrollTop = container.scrollHeight;
    }
}

async function sendMessage() {
    if (!activeUser || !currentUser) {
        return notify("Selecione uma conversa primeiro.");
    }

    const input = $("messageInput");
    const text = input?.value.trim();

    if (!text) return;

    if (text.length > 5000) {
        return notify("A mensagem é muito grande.");
    }

    const button = $("sendButton");

    if (button) button.disabled = true;

    try {
        await api("/messages", {
            method: "POST",
            body: {
                to: activeUser.id,
                text
            }
        });

        input.value = "";

        await loadMessages();
    } catch (error) {
        notify(error.message);
    } finally {
        if (button) button.disabled = false;
    }
}

// ===============================
// ATUALIZAÇÕES
// ===============================

async function refreshAll() {
    if (!currentUser) return;

    try {
        await Promise.all([
            loadFriends(),
            loadMessages()
        ]);

        // Só consulta atualizações quando o usuário está autenticado.
        await api("/updates");
    } catch (error) {
        if (!error.message.includes("expirou")) {
            console.error("Erro ao atualizar o chat:", error);
        }
    }
}

// ===============================
// SAIR DA CONTA
// ===============================

async function logout() {
    stopPolling();

    try {
        await api("/logout", {
            method: "POST"
        });
    } catch (error) {
        console.error(error);
    }

    currentUser = null;
    activeUser = null;

    hide($("appScreen"));
    hide($("registerScreen"));
    show($("loginScreen"));
}

// ===============================
// INICIAR
// ===============================

document.addEventListener("DOMContentLoaded", initialize);
