export default {
  async fetch(request, env) {
    const BACKEND_API_KEY = env.BACKEND_API_KEY;
    const CLIENT_API_KEY = env.CLIENT_API_KEY;
    const API_BASE = "https://integrate.api.nvidia.com/v1";
    const url = new URL(request.url);

    // 1. Health check — БЕЗ ключа (открывается в браузере)
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "CF Worker Proxy",
        supported_efforts: ["minimal", "low", "medium", "high", "extra-high", "max"]
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 2. CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      }});
    }

    // 3. Проверка ключа клиента — уже для рабочих эндпоинтов
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${CLIENT_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }

    // 4. Models
    if (url.pathname === "/v1/models" && request.method === "GET") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "custom-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: "proxy" }]
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 5. Chat completions
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const body = await request.json();
      if (!body.model) {
        return new Response(JSON.stringify({ error: "Parameter 'model' is required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      const nimRequest = {
        model: body.model,
        messages: body.messages || [],
        temperature: body.temperature || 0.6,
        max_tokens: body.max_tokens || 4096,
        stream: body.stream || false,
      };

      if (body.thinking || body.reasoning_effort) {
        const effort = body.reasoning_effort || "medium";
        if (!["off","none","disabled"].includes(String(effort).toLowerCase())) {
          nimRequest.extra_body = { chat_template_kwargs: { thinking: true, reasoning_effort: effort } };
        }
      }

      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${BACKEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(nimRequest),
      });

      if (body.stream) {
        return new Response(response.body, {
          status: response.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404, headers: { "Content-Type": "application/json" }
    });
  },
};
