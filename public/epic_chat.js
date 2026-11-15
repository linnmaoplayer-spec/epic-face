
const $ = id => document.getElementById(id);

let currentUser = null;
let friends = [];
let servers = [];
let currentFriend = null;
let authMode = "login";
let updateTimer = null;
let toastTimer = null;
let loadingMessages = false;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  let data = {};
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(data.error || `Erro HTTP ${response.status}`);
  }

  return data;
}

function notify(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2600);
}

function openModal(id) {
  $(id).classList.remove("hidden");
}

function closeModal(id) {
  $(id).classList.add("hidden");
}

document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => closeModal(button.dataset.close));
});

function setAvatar(element, user) {
  if (!element) return;

  element.style.backgroundImage = user?.avatar
    ? `url("${user.avatar}")`
    : "none";

  element.textContent = user?.avatar
    ? ""
    : (user?.username || "?").charAt(0).toUpperCase();
}

function showAuth() {
  $("authScreen").classList.remove("hidden");
  $("app").classList.add("hidden");
  if (updateTimer) clearInterval(updateTimer);
  currentUser = null;
  currentFriend = null;
}

function showApp() {
  $("authScreen").classList.add("hidden");
  $("app").classList.remove("hidden");

  $("myName").textContent = currentUser.username;
  $("myId").textContent = currentUser.id;
  setAvatar($("myAvatar"), currentUser);

  refreshAll();
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(refreshAll, 3000);
}

async function refreshAll() {
  if (!currentUser) return;

  try {
    const data = await api("/api/updates");
    currentUser = data.user;
    friends = data.friends || [];
    servers = data.servers || [];

    $("myName").textContent = currentUser.username;
    $("myId").textContent = currentUser.id;
    setAvatar($("myAvatar"), currentUser);

    renderFriends();
    renderServers();

    if (currentFriend) {
      const updated = friends.find(f => f.id === currentFriend.id);
      if (updated) {
        currentFriend = updated;
        await loadMessages(false);
      } else {
        currentFriend = null;
        showEmptyChat();
      }
    }
  } catch (e) {
    if (e.message.includes("login")) showAuth();
  }
}

// LOGIN / CADASTRO

$("loginTab").onclick = () => setAuthMode("login");
$("registerTab").onclick = () => setAuthMode("register");

function setAuthMode(mode) {
  authMode = mode;
  $("loginTab").classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  $("authSubmit").textContent = mode === "login" ? "ENTRAR" : "CRIAR CONTA";
  $("authPassword").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
}

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("authError").textContent = "";

  try {
    const result = await api(
      authMode === "login" ? "/api/login" : "/api/register",
      {
        method: "POST",
        body: JSON.stringify({
          username: $("authUsername").value.trim(),
          password: $("authPassword").value
        })
      }
    );

    currentUser = result.user;
    $("authPassword").value = "";
    showApp();
  } catch (e) {
    $("authError").textContent = e.message;
  }
});

// SAIR

$("logoutButton").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {}

  showAuth();
};

// AMIGOS

function renderFriends() {
  const list = $("friendsList");
  list.innerHTML = "";

  if (!friends.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Você ainda não tem amigos.";
    list.append(p);
    return;
  }

  friends.forEach(friend => {
    const button = document.createElement("button");
    button.className = "friend-item" +
      (currentFriend?.id === friend.id ? " selected" : "");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(avatar, friend);

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = friend.username;
    const id = document.createElement("small");
    id.textContent = friend.id;

    info.append(name, id);
    button.append(avatar, info);
    button.onclick = () => selectFriend(friend);
    list.append(button);
  });
}

async function selectFriend(friend) {
  currentFriend = friend;

  $("emptyChat").classList.add("hidden");
  $("messages").classList.remove("hidden");
  $("messageForm").classList.remove("hidden");

  $("chatName").textContent = friend.username;
  $("chatSubtitle").textContent = friend.id;
  setAvatar($("chatAvatar"), friend);

  renderFriends();
  await loadMessages();
}

function showEmptyChat() {
  $("emptyChat").classList.remove("hidden");
  $("messages").classList.add("hidden");
  $("messageForm").classList.add("hidden");
  $("chatName").textContent = "Selecione uma conversa";
  $("chatSubtitle").textContent = "EPIC CHAT";
  $("messages").innerHTML = "";
}

async function loadMessages(scroll = true) {
  if (!currentFriend || loadingMessages) return;

  loadingMessages = true;
  try {
    const data = await api(
      "/api/messages/" + encodeURIComponent(currentFriend.id)
    );
    renderMessages(data.messages || [], scroll);
  } catch (e) {
    console.error(e);
  } finally {
    loadingMessages = false;
  }
}

function renderMessages(items, scroll = true) {
  const box = $("messages");
  const oldScroll = box.scrollTop;
  const wasBottom =
    box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  box.innerHTML = "";

  items.forEach(m => {
    const mine = m.from === currentUser.id;
    const sender = mine ? currentUser : (m.sender || currentFriend);

    const row = document.createElement("div");
    row.className = "message" + (mine ? " mine" : "");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(avatar, sender);

    const content = document.createElement("div");
    content.className = "msg-content";

    const meta = document.createElement("div");
    meta.className = "msg-meta";

    const name = document.createElement("strong");
    name.textContent = sender?.username || "Usuário";

    const time = document.createElement("time");
    time.textContent = new Date(m.createdAt).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit"
    });

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;

    meta.append(name, time);
    content.append(meta, bubble);
    row.append(avatar, content);
    box.append(row);
  });

  if (scroll && (wasBottom || oldScroll === 0)) {
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = oldScroll;
  }
}

$("messageForm").addEventListener("submit", async e => {
  e.preventDefault();

  const text = $("messageInput").value.trim();
  if (!text || !currentFriend) return;

  $("messageInput").value = "";

  try {
    await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        to: currentFriend.id,
        text
      })
    });
    await loadMessages();
  } catch (e) {
    notify(e.message);
    $("messageInput").value = text;
  }
});

// PESQUISAR E ADICIONAR AMIGO

$("addFriendButton").onclick = () => {
  $("friendSearch").value = "";
  $("friendResults").innerHTML = "";
  $("friendError").textContent = "";
  openModal("friendModal");
};

$("searchFriend").onclick = async () => {
  const q = $("friendSearch").value.trim();
  if (!q) return;

  $("friendError").textContent = "";
  $("friendResults").textContent = "Pesquisando...";

  try {
    const data = await api("/api/users/search?q=" + encodeURIComponent(q));
    const box = $("friendResults");
    box.innerHTML = "";

    if (!data.users.length) {
      box.textContent = "Nenhum jogador encontrado.";
      return;
    }

    data.users.forEach(user => {
      const row = document.createElement("div");
      row.className = "result-user";

      const label = document.createElement("span");
      label.textContent = `${user.username} (${user.id})`;

      const button = document.createElement("button");
      button.className = "primary";
      button.textContent = "Adicionar";
      button.onclick = async () => {
        try {
          await api("/api/friends/request", {
            method: "POST",
            body: JSON.stringify({ user: user.id })
          });
          notify("Amigo adicionado!");
          closeModal("friendModal");
          await refreshAll();
        } catch (e) {
          $("friendError").textContent = e.message;
        }
      };

      row.append(label, button);
      box.append(row);
    });
  } catch (e) {
    $("friendError").textContent = e.message;
    $("friendResults").innerHTML = "";
  }
};

// PERFIL

$("profileButton").onclick = () => {
  $("profileUsername").value = currentUser.username;
  $("profileId").value = currentUser.id;
  $("avatarFile").value = "";
  $("profileError").textContent = "";
  setAvatar($("profileAvatar"), currentUser);
  openModal("profileModal");
};

$("saveProfile").onclick = async () => {
  try {
    $("profileError").textContent = "";
    let image = currentUser.avatar || null;

    const file = $("avatarFile").files[0];

    if (file) {
      if (file.size > 350 * 1024) {
        throw new Error("A foto precisa ter no máximo 350 KB.");
      }

      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
        throw new Error("Formato de imagem não permitido.");
      }

      image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Erro ao carregar a imagem."));
        reader.readAsDataURL(file);
      });
    }

    const result = await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({
        username: $("profileUsername").value.trim(),
        avatar: image
      })
    });

    currentUser = result.user;
    closeModal("profileModal");
    notify("Perfil atualizado!");
    await refreshAll();
  } catch (e) {
    $("profileError").textContent = e.message;
  }
};

// SERVIDORES

function renderServers() {
  const list = $("serversList");
  list.innerHTML = "";

  if (!servers.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Nenhum servidor ainda.";
    list.append(p);
    return;
  }

  servers.forEach(server => {
    const button = document.createElement("button");
    button.className = "server-item";

    const symbol = document.createElement("div");
    symbol.className = "server-symbol";
    symbol.textContent = "#";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = server.name;
    const id = document.createElement("small");
    id.textContent = server.id;

    info.append(name, id);
    button.append(symbol, info);
    button.onclick = () => serverDetails(server);
    list.append(button);
  });
}

$("createServerButton").onclick = createServerModal;
$("railCreateServer").onclick = createServerModal;

function createServerModal() {
  $("serverName").value = "";
  $("serverError").textContent = "";
  openModal("serverModal");
}

$("confirmServer").onclick = async () => {
  try {
    const result = await api("/api/servers", {
      method: "POST",
      body: JSON.stringify({ name: $("serverName").value.trim() })
    });

    closeModal("serverModal");
    notify("Servidor criado: " + result.server.id);
    await refreshAll();
    await createInvite(result.server.id);
  } catch (e) {
    $("serverError").textContent = e.message;
  }
};

async function createInvite(id) {
  try {
    const result = await api(`/api/servers/${encodeURIComponent(id)}/invites`, {
      method: "POST"
    });
    $("inviteCode").value = result.invite.code;
    openModal("inviteModal");
  } catch (e) {
    notify(e.message);
  }
}

async function serverDetails(server) {
  const option = confirm(
    `${server.name}\nID: ${server.id}\n\nOK para criar um convite.\nCancelar para fechar.`
  );
  if (option) await createInvite(server.id);
}

// CONVITES

$("joinServerButton").onclick = () => {
  $("joinCode").value = "";
  $("joinError").textContent = "";
  openModal("joinModal");
};

$("confirmJoin").onclick = async () => {
  try {
    const result = await api("/api/invites/join", {
      method: "POST",
      body: JSON.stringify({ code: $("joinCode").value.trim() })
    });

    closeModal("joinModal");
    notify("Você entrou em " + result.server.name);
    await refreshAll();
  } catch (e) {
    $("joinError").textContent = e.message;
  }
};

$("copyInvite").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("inviteCode").value);
    notify("Convite copiado!");
  } catch {
    $("inviteCode").select();
    notify("Copie o código selecionado.");
  }
};

$("refreshButton").onclick = refreshAll;

// INICIALIZAÇÃO

async function init() {
  try {
    const data = await api("/api/me");
    currentUser = data.user;
    showApp();
  } catch {
    showAuth();
  }
}

init();
