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
        service: "CF Worker Proxy"
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Проверка ключей
    if (!BACKEND_API_KEY || !CLIENT_API_KEY) {
      return new Response(JSON.stringify({ error: "Keys missing" }), { status: 500 });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${CLIENT_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
    }

    // Chat completions
    if (pathname === "/v1/chat/completions" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
      }

      if (!body.model || !body.messages) {
        return new Response(JSON.stringify({ error: "Missing model or messages" }), { status: 400 });
      }

      const nimRequest = {
        model: body.model,
        messages: body.messages,
        temperature: body.temperature || 0.7,
        max_tokens: body.max_tokens || 1024,
        stream: body.stream || false,
      };

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
          console.log("NVIDIA ERROR:", response.status, errorText);
          
          if (body.stream) {
            const errorSSE = `data: ${JSON.stringify({error: {message: errorText}})}\n\ndata: [DONE]\n\n`;
            return new Response(errorSSE, {
              status: response.status,
              headers: { "Content-Type": "text/event-stream" }
            });
          }
          return new Response(errorText, { status: response.status, headers: { "Content-Type": "application/json" } });
        }

        // 🔥 ЛОГИРОВАНИЕ: смотрим что возвращает NVIDIA
        const responseText = await response.text();
        console.log("NVIDIA RESPONSE (first 500 chars):", responseText.substring(0, 500));
        console.log("Client requested stream:", body.stream);

        // Если клиент просил стриминг
        if (body.stream) {
          // Проверяем, является ли ответ SSE (начинается с "data: ")
          if (responseText.startsWith("data: ")) {
            // Это уже SSE, пробрасываем как есть
            console.log("Returning SSE stream directly");
            return new Response(responseText, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
              }
            });
          } else {
            // Это обычный JSON, конвертируем в SSE
            console.log("Converting JSON to SSE");
            try {
              const data = JSON.parse(responseText);
              const content = data.choices?.[0]?.message?.content || '';
              const chunk = {
                id: data.id || "chatcmpl-1",
                object: "chat.completion.chunk",
                created: data.created || Math.floor(Date.now() / 1000),
                model: data.model || body.model,
                choices: [{
                  index: 0,
                  delta: { content: content },
                  finish_reason: "stop"
                }]
              };
              const sse = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
              console.log("SSE response:", sse.substring(0, 200));
              return new Response(sse, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache"
                }
              });
            } catch (e) {
              console.error("Failed to parse JSON:", e);
              return new Response(`data: ${JSON.stringify({error: {message: "Failed to parse response"}})}\n\ndata: [DONE]\n\n`, {
                status: 500,
                headers: { "Content-Type": "text/event-stream" }
              });
            }
          }
        }

        // Обычный JSON
        console.log("Returning JSON response");
        return new Response(responseText, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
        
      } catch (err) {
        console.error("Network error:", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 502 });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
  },
};
