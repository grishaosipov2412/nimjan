export default {
  async fetch(request, env) {
    const BACKEND_API_KEY = env.BACKEND_API_KEY;
    const CLIENT_API_KEY = env.CLIENT_API_KEY;
    const API_BASE = "https://integrate.api.nvidia.com/v1";

    // CORS для браузерных клиентов
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    
    // Проверка API ключа клиента
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${CLIENT_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), { 
        status: 401, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    // Health check endpoint
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ 
        status: "ok", 
        service: "CF Worker Proxy",
        supported_efforts: ["minimal", "low", "medium", "high", "extra-high", "max"]
      }), { 
        headers: { "Content-Type": "application/json" } 
      });
    }

    // Models endpoint
    if (url.pathname === "/v1/models" && request.method === "GET") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          id: "custom-model",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "proxy"
        }]
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Chat completions endpoint
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const body = await request.json();
      
      // Валидация
      if (!body.model) {
        return new Response(JSON.stringify({ error: "Parameter 'model' is required" }), { 
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Формируем запрос к NVIDIA
      const nimRequest = {
        model: body.model,
        messages: body.messages || [],
        temperature: body.temperature || 0.6,
        max_tokens: body.max_tokens || 4096,
        stream: body.stream || false,
      };

      // Добавляем thinking/reasoning, если клиент просит
      if (body.thinking || body.reasoning_effort) {
        const effort = body.reasoning_effort || "medium";
        const effortOff = ["off", "none", "disabled"].includes(effort.toLowerCase());
        
        if (!effortOff) {
          nimRequest.extra_body = {
            chat_template_kwargs: { 
              thinking: true, 
              reasoning_effort: effort
            }
          };
        }
      }

      // Запрос к NVIDIA API
      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${BACKEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(nimRequest),
      });

      // Если стриминг - пробрасываем поток напрямую
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

      // Если не стриминг - возвращаем JSON
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        },
      });
    }

    // 404 для всех остальных путей
    return new Response(JSON.stringify({ error: "Not Found" }), { 
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  },
};