export default {
  async fetch(request, env) {
    const BACKEND_API_KEY = env.BACKEND_API_KEY;
    const CLIENT_API_KEY = env.CLIENT_API_KEY;
    const API_BASE = "https://integrate.api.nvidia.com/v1";
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, "");

    // CORS
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

    // Health check
    if (pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "CF Worker Proxy",
        supported_efforts: ["minimal", "low", "medium", "high", "extra-high", "max"],
        config: { BACKEND_API_KEY_set: !!BACKEND_API_KEY, CLIENT_API_KEY_set: !!CLIENT_API_KEY }
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // Проверка ключей
    if (!BACKEND_API_KEY || !CLIENT_API_KEY) {
      return new Response(JSON.stringify({ error: "Server config error: Keys missing" }), {
        status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Проверка ключа клиента
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${CLIENT_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Chat completions
    if (pathname === "/v1/chat/completions" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      if (!body.model || !body.messages || body.messages.length === 0) {
        return new Response(JSON.stringify({ error: "Parameter 'model' and non-empty 'messages' are required" }), {
          status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Запрос к NVIDIA
      const nimRequest = {
        model: body.model,
        messages: body.messages,
        temperature: body.temperature !== undefined ? body.temperature : 0.7,
        max_tokens: body.max_tokens || 1024,
        stream: body.stream || false,
      };

      if (body.thinking || body.reasoning_effort) {
        const effort = body.reasoning_effort || "medium";
        if (!["off", "none", "disabled"].includes(String(effort).toLowerCase())) {
          nimRequest.thinking = true;
          nimRequest.reasoning_effort = effort;
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

        // Ошибки от NVIDIA
        if (!response.ok) {
          const errorText = await response.text();
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch (e) {
            errorData = { error: { message: errorText.substring(0, 300) } };
          }
          
          if (body.stream) {
            const errorSSE = `data: ${JSON.stringify(errorData)}\n\ndata: [DONE]\n\n`;
            return new Response(errorSSE, {
              status: response.status,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*"
              }
            });
          }
          
          return new Response(JSON.stringify(errorData), {
            status: response.status,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // 🔥 ОПТИМИЗАЦИЯ: нативный стриминг без парсинга
        if (body.stream) {
          return new Response(response.body, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Обычный JSON
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
        
      } catch (err) {
        const errorResponse = { error: "Network error to upstream: " + err.message };
        
        if (body.stream) {
          const errorSSE = `data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`;
          return new Response(errorSSE, {
            status: 502,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        
        return new Response(JSON.stringify(errorResponse), {
          status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found: " + pathname }), {
      status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  },
};
