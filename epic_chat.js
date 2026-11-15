async function api(endpoint, options = {}) {
    const response = await fetch("/api" + endpoint, {
        ...options,
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
        console.warn("Sessão não autenticada:", endpoint);
        throw new Error("Você precisa entrar novamente.");
    }

    if (!response.ok) {
        throw new Error(data.error || "Erro na comunicação com o servidor.");
    }

    return data;
}