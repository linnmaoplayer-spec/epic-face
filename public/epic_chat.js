
"use strict";

/* =========================================================
   EPIC CHAT - epic_chat.js
   API: Node.js + Express + JSONBin
========================================================= */

const API = "/api";

let currentUser = null;
let activeUser = null;
let messagesTimer = null;
let searchTimer = null;

const $ = (id) => document.getElementById(id);

const elements = {
    loginScreen: $("loginScreen"),
    appScreen: $("appScreen"),

    loginForm: $("loginForm"),
    registerForm: $("registerForm"),

    loginUsername: $("loginUsername"),
    loginPassword: $("loginPassword"),
    registerUsername: $("registerUsername"),
    registerPassword: $("registerPassword"),

    showRegister: $("showRegister"),
    showLogin: $("showLogin"),

    currentAvatar: $("currentAvatar"),
    currentUsername: $("currentUsername"),
    currentPlayerId: $("currentPlayerId"),

    searchInput: $("searchInput"),
    searchResults: $("searchResults"),
    friendsList: $("friendsList"),

    emptyChat: $("emptyChat"),
    activeChat: $("activeChat"),
    chatAvatar: $("chatAvatar"),
    chatUsername: $("chatUsername"),
    chatId: $("chatId"),
    messagesList: $("messagesList"),

    messageInput: $("messageInput"),
    sendButton: $("sendButton"),

    logoutButton: $("logoutButton"),

    profileButton: $("profileButton"),
    profileModal: $("profileModal"),
    profileForm: $("profileForm"),
    profileUsername: $("profileUsername"),
    profileAvatarInput: $("profileAvatarInput"),
    profilePreview: $("profilePreview"),
    closeProfileModal: $("closeProfileModal")
};

/* =========================================================
   API
========================================================= */

async function api(endpoint, options = {}) {
    const response = await fetch(API + endpoint, {
        credentials: "same-origin",
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || data.message || "Erro na comunicação com o servidor.");
    }

    return data;
}

function notify(message) {
    alert(message);
}

function setVisible(element, visible) {
    if (!element) return;
    element.classList.toggle("hidden", !visible);
}

function showLoginScreen() {
    setVisible(elements.loginScreen, true);
    setVisible(elements.appScreen, false);
}

function showAppScreen() {
    setVisible(elements.loginScreen, false);
    setVisible(elements.appScreen, true);
}

/* =========================================================
   PERFIL
========================================================= */

function updateProfileUI() {
    if (!currentUser) return;

    if (elements.currentUsername) {
        elements.currentUsername.textContent = currentUser.username;
    }

    if (elements.currentPlayerId) {
        elements.currentPlayerId.textContent = currentUser.id;
    }

    const avatar = currentUser.avatar || "/icon.png";

    if (elements.currentAvatar) {
        elements.currentAvatar.src = avatar;
    }
}

async function openProfileEditor() {
    if (!currentUser) return;

    if (elements.profileUsername) {
        elements.profileUsername.value = currentUser.username || "";
    }

    if (elements.profilePreview) {
        elements.profilePreview.src = currentUser.avatar || "/icon.png";
    }

    setVisible(elements.profileModal, true);
}

async function saveProfile(event) {
    event.preventDefault();

    const username = elements.profileUsername?.value.trim();

    if (!username || username.length < 3 || username.length > 24) {
        notify("O nome precisa ter entre 3 e 24 caracteres.");
        return;
    }

    let avatar = currentUser.avatar || "";

    const file = elements.profileAvatarInput?.files?.[0];

    if (file) {
        if (!file.type.startsWith("image/")) {
            notify("Selecione um arquivo de imagem válido.");
            return;
        }

        if (file.size > 4 * 1024 * 1024) {
            notify("A imagem deve ter no máximo 4 MB.");
            return;
        }

        avatar = await fileToBase64(file);
    }

    try {
        const result = await api("/profile", {
            method: "PATCH",
            body: JSON.stringify({ username, avatar })
        });

        currentUser = result.user || result;
        updateProfileUI();

        setVisible(elements.profileModal, false);

        await loadFriends();

        notify("Perfil atualizado!");
    } catch (error) {
        notify(error.message);
    }
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;

        reader.readAsDataURL(file);
    });
}

/* =========================================================
   LOGIN E CADASTRO
========================================================= */

async function login(event) {
    event.preventDefault();

    const username = elements.loginUsername?.value.trim();
    const password = elements.loginPassword?.value;

    if (!username || !password) {
        notify("Preencha todos os campos.");
        return;
    }

    try {
        const result = await api("/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        currentUser = result.user || result;

        await startChat();
    } catch (error) {
        notify(error.message);
    }
}

async function register(event) {
    event.preventDefault();

    const username = elements.registerUsername?.value.trim();
    const password = elements.registerPassword?.value;

    if (!username || !password) {
        notify("Preencha todos os campos.");
        return;
    }

    if (username.length < 3 || username.length > 24) {
        notify("O nome precisa ter entre 3 e 24 caracteres.");
        return;
    }

    if (password.length < 6) {
        notify("A senha precisa ter pelo menos 6 caracteres.");
        return;
    }

    try {
        const result = await api("/register", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        currentUser = result.user || result;

        await startChat();
    } catch (error) {
        notify(error.message);
    }
}

async function logout() {
    try {
        await api("/logout", { method: "POST" });
    } catch (error) {
        console.error(error);
    }

    currentUser = null;
    activeUser = null;

    clearInterval(messagesTimer);

    showLoginScreen();
}

/* =========================================================
   INICIALIZAÇÃO
========================================================= */

async function initializeChat() {
    try {
        const result = await api("/me");

        currentUser = result.user || result;

        if (currentUser && currentUser.id) {
            await startChat();
        } else {
            showLoginScreen();
        }
    } catch {
        showLoginScreen();
    }
}

async function startChat() {
    if (!currentUser) return;

    showAppScreen();
    updateProfileUI();

    await loadFriends();

    if (messagesTimer) {
        clearInterval(messagesTimer);
    }

    messagesTimer = setInterval(() => {
        if (activeUser) {
            loadMessages();
        }
    }, 2500);
}

/* =========================================================
   PESQUISA DE JOGADORES
========================================================= */

async function searchUsers() {
    const query = elements.searchInput?.value.trim();

    if (!query) {
        elements.searchResults?.replaceChildren();
        return;
    }

    try {
        const result = await api(
            "/users/search?q=" + encodeURIComponent(query)
        );

        renderSearchResults(result.users || []);
    } catch (error) {
        console.error("Erro na pesquisa:", error);
    }
}

function renderSearchResults(users) {
    if (!elements.searchResults) return;

    elements.searchResults.replaceChildren();

    users.forEach(user => {
        if (user.id === currentUser?.id) return;

        const item = document.createElement("button");
        item.type = "button";
        item.className = "search-result";

        const avatar = document.createElement("img");
        avatar.src = user.avatar || "/icon.png";
        avatar.alt = "";

        const info = document.createElement("span");

        const name = document.createElement("strong");
        name.textContent = user.username;

        const id = document.createElement("small");
        id.textContent = user.id;

        info.append(name, id);
        item.append(avatar, info);

        item.addEventListener("click", () => {
            openChat(user);
            elements.searchResults.replaceChildren();
        });

        elements.searchResults.appendChild(item);
    });
}

/* =========================================================
   AMIGOS
========================================================= */

async function loadFriends() {
    try {
        const result = await api("/friends");

        renderFriends(result.friends || []);
    } catch (error) {
        console.error("Erro ao carregar amigos:", error);
    }
}

function renderFriends(friends) {
    if (!elements.friendsList) return;

    elements.friendsList.replaceChildren();

    friends.forEach(friend => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "friend-item";

        const avatar = document.createElement("img");
        avatar.src = friend.avatar || "/icon.png";
        avatar.alt = "";

        const info = document.createElement("span");

        const name = document.createElement("strong");
        name.textContent = friend.username;

        const id = document.createElement("small");
        id.textContent = friend.id;

        info.append(name, id);
        item.append(avatar, info);

        item.addEventListener("click", () => openChat(friend));

        elements.friendsList.appendChild(item);
    });
}

/* =========================================================
   CONVERSAS
========================================================= */

async function openChat(user) {
    if (!user || !user.username) return;

    activeUser = user;

    setVisible(elements.emptyChat, false);
    setVisible(elements.activeChat, true);

    if (elements.chatUsername) {
        elements.chatUsername.textContent = user.username;
    }

    if (elements.chatId) {
        elements.chatId.textContent = user.id || "";
    }

    if (elements.chatAvatar) {
        elements.chatAvatar.src = user.avatar || "/icon.png";
    }

    await loadMessages();

    elements.messageInput?.focus();
}

async function loadMessages() {
    if (!activeUser) return;

    try {
        const result = await api(
            "/messages/" + encodeURIComponent(activeUser.username)
        );

        renderMessages(result.messages || []);
    } catch (error) {
        console.error("Erro ao carregar mensagens:", error);
    }
}

function renderMessages(messages) {
    if (!elements.messagesList) return;

    const previousScroll =
        elements.messagesList.scrollHeight -
        elements.messagesList.scrollTop -
        elements.messagesList.clientHeight;

    elements.messagesList.replaceChildren();

    messages.forEach(message => {
        const mine = message.from === currentUser.id;

        const item = document.createElement("div");
        item.className = mine ? "message mine" : "message";

        const avatar = document.createElement("img");
        avatar.src = message.sender?.avatar || "/icon.png";
        avatar.alt = "";

        const content = document.createElement("div");
        content.className = "message-content";

        const author = document.createElement("strong");
        author.textContent = mine
            ? currentUser.username
            : (message.sender?.username || activeUser.username);

        const text = document.createElement("p");
        text.textContent = message.text || "";

        const date = document.createElement("small");

        if (message.createdAt) {
            date.textContent = new Date(message.createdAt).toLocaleString();
        }

        content.append(author, text, date);
        item.append(avatar, content);

        elements.messagesList.appendChild(item);
    });

    const shouldScroll = previousScroll < 100;

    if (shouldScroll) {
        elements.messagesList.scrollTop =
            elements.messagesList.scrollHeight;
    }
}

/* =========================================================
   ENVIAR MENSAGENS
========================================================= */

async function sendMessage(event) {
    event?.preventDefault();

    if (!activeUser) {
        notify("Selecione uma conversa primeiro.");
        return;
    }

    const text = elements.messageInput?.value.trim();

    if (!text) return;

    if (text.length > 4000) {
        notify("A mensagem é muito grande.");
        return;
    }

    if (elements.sendButton) {
        elements.sendButton.disabled = true;
    }

    try {
        await api("/messages", {
            method: "POST",
            body: JSON.stringify({
                to: activeUser.id,
                text
            })
        });

        elements.messageInput.value = "";

        await loadMessages();
    } catch (error) {
        notify(error.message);
    } finally {
        if (elements.sendButton) {
            elements.sendButton.disabled = false;
        }

        elements.messageInput?.focus();
    }
}

/* =========================================================
   EVENTOS
========================================================= */

elements.loginForm?.addEventListener("submit", login);
elements.registerForm?.addEventListener("submit", register);

elements.showRegister?.addEventListener("click", () => {
    setVisible(elements.loginScreen, false);
    setVisible(elements.registerForm, true);
});

elements.showLogin?.addEventListener("click", () => {
    setVisible(elements.registerForm, false);
    setVisible(elements.loginScreen, true);
});

elements.searchInput?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchUsers, 300);
});

elements.sendButton?.addEventListener("click", sendMessage);

elements.messageInput?.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage(event);
    }
});

elements.logoutButton?.addEventListener("click", logout);

elements.profileButton?.addEventListener("click", openProfileEditor);

elements.profileForm?.addEventListener("submit", saveProfile);

elements.closeProfileModal?.addEventListener("click", () => {
    setVisible(elements.profileModal, false);
});

elements.profileAvatarInput?.addEventListener("change", async () => {
    const file = elements.profileAvatarInput.files?.[0];

    if (!file || !elements.profilePreview) return;

    if (!file.type.startsWith("image/")) {
        notify("Selecione uma imagem válida.");
        return;
    }

    elements.profilePreview.src = await fileToBase64(file);
});

/* =========================================================
   INICIAR
========================================================= */

document.addEventListener("DOMContentLoaded", initializeChat);
