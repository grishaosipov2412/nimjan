export default {
  async fetch(request, env) {
    // ВРЕМЕННЫЙ ТЕСТ: если переменные из дашборда не читаются, используем хардкод
    const BACKEND_API_KEY = env.BACKEND_API_KEY || "nvapi-ТВОЙ_РЕАЛЬНЫЙ_КЛЮЧ_NVIDIA";
    const CLIENT_API_KEY = env.CLIENT_API_KEY || "123456789";
    const API_BASE = "https://integrate.api.nvidia.com/v1";
    const url = new URL(request.url);
    
    // Убираем возможный слэш в конце пути
    const pathname = url.pathname.replace(/\/$/, ""); 

    // 1. CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    // 2. Health check (без ключа)
    if (pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "CF Worker Proxy",
        supported_efforts: ["minimal", "low", "medium", "high", "extra-high", "max"]
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 3. Проверка ключа клиента
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${CLIENT_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 4. Models endpoint
    if (pathname === "/v1/models" && request.method === "GET") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "custom-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: "proxy" }]
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 5. Chat completions
    if (pathname === "/v1/chat/completions" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      if (!body.model) {
        return new Response(JSON.stringify({ error: "Parameter 'model' is required" }), {
          status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const nimRequest = {
        model: body.model,
        messages: body.messages || [],
        temperature: body.temperature !== undefined ? body.temperature : 0.6,
        max_tokens: body.max_tokens || 4096,
        stream: body.stream || false,
      };

      if (body.thinking || body.reasoning_effort) {
        const effort = body.reasoning_effort || "medium";
        if (!["off", "none", "disabled"].includes(String(effort).toLowerCase())) {
          nimRequest.extra_body = { chat_template_kwargs: { thinking: true, reasoning_effort: effort } };
        }
      }

      try {
        const response = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${BACKEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(nimRequest),
        });

        const responseHeaders = {
          "Content-Type": body.stream ? "text/event-stream" : "application/json",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        };
        if (body.stream) responseHeaders["Connection"] = "keep-alive";

        if (body.stream) {
          return new Response(response.body, { status: response.status, headers: responseHeaders });
        }

        const data = await response.json();
        return new Response(JSON.stringify(data), { status: response.status, headers: responseHeaders });
        
      } catch (err) {
        return new Response(JSON.stringify({ error: "Upstream error: " + err.message }), {
          status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 6. 404 для всего остального
    return new Response(JSON.stringify({ error: "Not Found: " + pathname }), {
      status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  },
};
