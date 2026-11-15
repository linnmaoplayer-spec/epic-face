
"use strict";

const API = "/api";
const $ = id => document.getElementById(id);

let currentUser = null;
let currentFriend = null;
let friends = [];
let polling = null;
let searchTimeout = null;
let registering = false;

async function api(route, options = {}) {
    const config = {
        method: options.method || "GET",
        credentials: "same-origin",
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {})
        }
    };

    if (options.body) {
        config.body = JSON.stringify(options.body);
    }

    const response = await fetch(API + route, config);

    let data = {};

    try {
        data = await response.json();
    } catch {}

    if (response.status === 401) {
        throw new Error("Sua sessão expirou. Entre novamente.");
    }

    if (!response.ok) {
        throw new Error(data.error || `Erro ${response.status}`);
    }

    return data;
}

function toast(message) {
    const element = $("toast");
    if (!element) return;

    element.textContent = message;
    element.classList.remove("hidden");

    clearTimeout(toast.timer);

    toast.timer = setTimeout(() => {
        element.classList.add("hidden");
    }, 3000);
}

function setAuthMode(create) {
    registering = create;

    $("authTitle").textContent = create
        ? "Criar sua conta"
        : "Entre na sua conta";

    $("authSub").textContent = create
        ? "Crie sua conta para começar a conversar."
        : "Continue de onde suas conversas pararam.";

    $("authSubmit").textContent = create ? "Criar conta" : "Entrar";
    $("switchText").textContent = create
        ? "Já tem uma conta?"
        : "Ainda não tem uma conta?";

    $("switchMode").textContent = create ? "Entrar" : "Criar conta";
    $("password").autocomplete = create ? "new-password" : "current-password";
    $("authError").textContent = "";
}

function showApp() {
    $("auth").classList.add("hidden");
    $("app").classList.remove("hidden");

    updateProfile();
    loadFriends();

    if (polling) clearInterval(polling);

    polling = setInterval(refreshAll, 5000);
}

function updateProfile() {
    if (!currentUser) return;

    const name = currentUser.username || "Usuário";
    const initial = name.charAt(0).toUpperCase();

    $("topName").textContent = name;
    $("sideName").textContent = name;
    $("topAvatar").textContent = initial;
    $("sideAvatar").textContent = initial;
    $("accountId").textContent = "ID: " + currentUser.id;

    if (currentUser.avatar) {
        $("topAvatar").style.backgroundImage = `url("${currentUser.avatar}")`;
        $("sideAvatar").style.backgroundImage = `url("${currentUser.avatar}")`;
    } else {
        $("topAvatar").style.backgroundImage = "";
        $("sideAvatar").style.backgroundImage = "";
    }
}

// ==============================
// LOGIN E CADASTRO
// ==============================

$("switchMode").addEventListener("click", () => {
    setAuthMode(!registering);
});

$("authForm").addEventListener("submit", async event => {
    event.preventDefault();

    const username = $("username").value.trim();
    const password = $("password").value;

    $("authSubmit").disabled = true;
    $("authError").textContent = "";

    try {
        const data = await api(registering ? "/register" : "/login", {
            method: "POST",
            body: { username, password }
        });

        currentUser = data.user;

        showApp();
    } catch (error) {
        $("authError").textContent = error.message;
    } finally {
        $("authSubmit").disabled = false;
    }
});

async function initialize() {
    try {
        const data = await api("/me");

        currentUser = data.user;
        showApp();
    } catch {
        $("auth").classList.remove("hidden");
        $("app").classList.add("hidden");
    }
}

// ==============================
// AMIGOS
// ==============================

async function loadFriends() {
    if (!currentUser) return;

    try {
        const data = await api("/friends");

        friends = data.friends || [];

        renderFriends();
    } catch (error) {
        console.error("Erro ao carregar amigos:", error);
    }
}

function renderFriends() {
    const container = $("friendList");

    container.replaceChildren();

    $("friendCount").textContent = friends.length;

    if (!friends.length) {
        const empty = document.createElement("p");

        empty.className = "empty-friends";
        empty.textContent = "Nenhum amigo ainda.";

        container.appendChild(empty);
        return;
    }

    friends.forEach(friend => {
        const button = document.createElement("button");

        button.className =
            "friend" + (currentFriend?.id === friend.id ? " active" : "");

        const avatar = document.createElement("div");
        avatar.className = "avatar";

        if (friend.avatar) {
            avatar.style.backgroundImage = `url("${friend.avatar}")`;
        } else {
            avatar.textContent = friend.username[0].toUpperCase();
        }

        const info = document.createElement("div");
        info.className = "friend-info";

        const name = document.createElement("div");
        name.className = "friend-name";
        name.textContent = friend.username;

        const status = document.createElement("div");
        status.className = "status";
        status.textContent = friend.id;

        info.append(name, status);
        button.append(avatar, info);

        button.addEventListener("click", () => openChat(friend));

        container.appendChild(button);
    });
}

// ==============================
// PESQUISA
// ==============================

$("friendQuery").addEventListener("input", () => {
    clearTimeout(searchTimeout);

    const query = $("friendQuery").value.trim();

    if (!query) {
        $("searchResults").replaceChildren();
        return;
    }

    searchTimeout = setTimeout(() => searchUsers(query), 300);
});

async function searchUsers(query) {
    try {
        const data = await api(
            "/users/search?q=" + encodeURIComponent(query)
        );

        const container = $("searchResults");

        container.replaceChildren();

        const users = data.users || [];

        if (!users.length) {
            const empty = document.createElement("p");
            empty.textContent = "Nenhum usuário encontrado.";
            empty.className = "search-empty";
            container.appendChild(empty);
            return;
        }

        users.forEach(user => {
            const item = document.createElement("div");
            item.className = "search-result";

            const info = document.createElement("div");
            info.className = "search-info";

            const name = document.createElement("strong");
            name.textContent = user.username;

            const id = document.createElement("small");
            id.textContent = user.id;

            const button = document.createElement("button");
            button.textContent = friends.some(f => f.id === user.id)
                ? "Abrir"
                : "Adicionar";

            button.addEventListener("click", async () => {
                try {
                    if (!friends.some(f => f.id === user.id)) {
                        await api("/friends/request", {
                            method: "POST",
                            body: { user: user.id }
                        });

                        await loadFriends();
                        toast("Usuário adicionado!");
                    }

                    $("friendModal").classList.add("hidden");
                    openChat(user);
                } catch (error) {
                    toast(error.message);
                }
            });

            info.append(name, id);
            item.append(info, button);
            container.appendChild(item);
        });
    } catch (error) {
        console.error(error);
    }
}

// ==============================
// ABRIR CONVERSA
// ==============================

async function openChat(friend) {
    currentFriend = friend;

    $("welcome").classList.add("hidden");
    $("chatHead").classList.remove("hidden");
    $("messages").classList.remove("hidden");
    $("composerWrap").classList.remove("hidden");

    $("chatName").textContent = friend.username;
    $("chatStatus").textContent = friend.id;

    if (friend.avatar) {
        $("chatAvatar").style.backgroundImage = `url("${friend.avatar}")`;
        $("chatAvatar").textContent = "";
    } else {
        $("chatAvatar").style.backgroundImage = "";
        $("chatAvatar").textContent = friend.username[0].toUpperCase();
    }

    renderFriends();

    await loadMessages();

    $("messageInput").focus();
}

async function loadMessages() {
    if (!currentFriend) return;

    try {
        const data = await api(
            "/messages/" + encodeURIComponent(currentFriend.id)
        );

        renderMessages(data.messages || []);
    } catch (error) {
        console.error("Erro ao carregar mensagens:", error);
    }
}

function renderMessages(messages) {
    const container = $("messages");

    container.replaceChildren();

    if (!messages.length) {
        const empty = document.createElement("div");
        empty.className = "day-divider";
        empty.textContent = "INÍCIO DA CONVERSA";

        container.appendChild(empty);
        return;
    }

    messages.forEach(message => {
        const mine = message.from === currentUser.id;

        const row = document.createElement("div");
        row.className = "message" + (mine ? " mine" : "");

        const avatar = document.createElement("div");
        avatar.className = "avatar";

        const sender = message.sender;

        if (sender?.avatar) {
            avatar.style.backgroundImage = `url("${sender.avatar}")`;
        } else {
            avatar.textContent = (sender?.username || (mine
                ? currentUser.username
                : currentFriend.username))[0].toUpperCase();
        }

        const content = document.createElement("div");
        content.className = "msg-content";

        const meta = document.createElement("div");
        meta.className = "msg-meta";

        const name = document.createElement("strong");
        name.textContent = mine ? "Você" : currentFriend.username;

        const time = document.createElement("time");

        if (message.createdAt) {
            time.textContent = new Date(message.createdAt)
                .toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit"
                });
        }

        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = message.text;

        meta.append(name, time);
        content.append(meta, bubble);
        row.append(avatar, content);

        container.appendChild(row);
    });

    container.scrollTop = container.scrollHeight;
}

// ==============================
// ENVIAR MENSAGEM
// ==============================

async function sendMessage() {
    if (!currentFriend) {
        return toast("Escolha uma conversa primeiro.");
    }

    const input = $("messageInput");
    const text = input.value.trim();

    if (!text) return;

    if (text.length > 5000) {
        return toast("A mensagem é muito grande.");
    }

    $("sendBtn").disabled = true;

    try {
        await api("/messages", {
            method: "POST",
            body: {
                to: currentFriend.id,
                text
            }
        });

        input.value = "";
        input.style.height = "auto";

        await loadMessages();
    } catch (error) {
        toast(error.message);
    } finally {
        $("sendBtn").disabled = false;
        input.focus();
    }
}

$("sendBtn").addEventListener("click", sendMessage);

$("messageInput").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
});

$("messageInput").addEventListener("input", event => {
    event.target.style.height = "auto";
    event.target.style.height =
        Math.min(event.target.scrollHeight, 130) + "px";
});

// ==============================
// MODAL DE AMIGOS
// ==============================

function openFriendModal() {
    $("friendQuery").value = "";
    $("searchResults").replaceChildren();

    $("friendModal").classList.remove("hidden");
    $("friendQuery").focus();
}

$("addFriendBtn").addEventListener("click", openFriendModal);
$("welcomeAdd").addEventListener("click", openFriendModal);

$("cancelFriend").addEventListener("click", () => {
    $("friendModal").classList.add("hidden");
});

$("friendQuery").addEventListener("keydown", event => {
    if (event.key === "Enter") {
        event.preventDefault();

        const query = event.target.value.trim();

        if (query) searchUsers(query);
    }
});

// ==============================
// PERFIL
// ==============================

$("profileBtn").addEventListener("click", () => {
    $("profileUsername").value = currentUser.username;
    $("profileAvatarInput").value = "";

    if (currentUser.avatar) {
        $("profilePreview").src = currentUser.avatar;
    } else {
        $("profilePreview").src = "/icon.png";
    }

    $("profileModal").classList.remove("hidden");
});

$("closeProfile").addEventListener("click", () => {
    $("profileModal").classList.add("hidden");
});

$("profileAvatarInput").addEventListener("change", event => {
    const file = event.target.files[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
        return toast("Selecione uma imagem.");
    }

    if (file.size > 3 * 1024 * 1024) {
        return toast("A imagem deve ter no máximo 3 MB.");
    }

    const reader = new FileReader();

    reader.onload = () => {
        $("profilePreview").src = reader.result;
    };

    reader.readAsDataURL(file);
});

$("profileForm").addEventListener("submit", async event => {
    event.preventDefault();

    const username = $("profileUsername").value.trim();

    if (username.length < 3 || username.length > 24) {
        return toast("O nome precisa ter entre 3 e 24 caracteres.");
    }

    let avatar = currentUser.avatar || "";

    const file = $("profileAvatarInput").files[0];

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

        currentUser = data.user;

        updateProfile();

        $("profileModal").classList.add("hidden");

        toast("Perfil atualizado!");
        await loadFriends();
    } catch (error) {
        toast(error.message);
    }
});

// ==============================
// ATUALIZAÇÃO AUTOMÁTICA
// ==============================

async function refreshAll() {
    if (!currentUser) return;

    try {
        await loadFriends();

        if (currentFriend) {
            await loadMessages();
        }

        await api("/updates");
    } catch (error) {
        console.error("Atualização:", error);
    }
}

// ==============================
// NAVEGAÇÃO E LOGOUT
// ==============================

$("friendsNav").addEventListener("click", () => {
    currentFriend = null;

    $("chatHead").classList.add("hidden");
    $("messages").classList.add("hidden");
    $("composerWrap").classList.add("hidden");
    $("welcome").classList.remove("hidden");

    renderFriends();
});

async function logout() {
    try {
        await api("/logout", { method: "POST" });
    } catch (error) {
        console.error(error);
    }

    if (polling) clearInterval(polling);

    currentUser = null;
    currentFriend = null;
    friends = [];

    $("app").classList.add("hidden");
    $("auth").classList.remove("hidden");

    $("password").value = "";

    setAuthMode(false);
}

$("logoutBtn").addEventListener("click", logout);
$("sideLogout").addEventListener("click", logout);

// ==============================
// INICIAR
// ==============================

initialize();
