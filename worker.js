export default {
  async fetch(request, env) {
    const BACKEND_API_KEY = env.BACKEND_API_KEY;
    const CLIENT_API_KEY = env.CLIENT_API_KEY;
    const API_BASE = "https://integrate.api.nvidia.com/v1";
    const SHOW_REASONING = (env.SHOW_REASONING || "true").toLowerCase() === "true";
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
        show_reasoning: SHOW_REASONING
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Models
    if (pathname === "/v1/models" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${CLIENT_API_KEY}`) {
        return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
      }
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "custom-model", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" }]
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Chat completions
    if (pathname === "/v1/chat/completions" && request.method === "POST") {
      if (!BACKEND_API_KEY || !CLIENT_API_KEY) {
        return new Response(JSON.stringify({ error: "Server config error" }), { status: 500 });
      }
      if (request.headers.get("Authorization") !== `Bearer ${CLIENT_API_KEY}`) {
        return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
      }

      if (!body.model || !body.messages || !body.messages.length) {
        return new Response(JSON.stringify({ error: "Missing model or messages" }), { status: 400 });
      }

      // 🔥 ВСЕГДА запрашиваем stream: false у NVIDIA, чтобы получить полный JSON
      const nimRequest = {
        model: body.model,
        messages: body.messages,
        temperature: body.temperature !== undefined ? body.temperature : 0.7,
        max_tokens: body.max_tokens || 1024,
        stream: false, // Всегда false!
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
          console.log("NVIDIA ERROR:", response.status, errorText);
          // Возвращаем ошибку в SSE-формате для Janitor AI
          const errorSSE = `data: ${JSON.stringify({ error: { message: errorText } })}\n\ndata: [DONE]\n\n`;
          return new Response(errorSSE, {
            status: response.status,
            headers: { "Content-Type": "text/event-stream" }
          });
        }

        // Получаем полный JSON от NVIDIA
        const data = await response.json();
        console.log("NVIDIA RESPONSE:", JSON.stringify(data).substring(0, 500));

        // Извлекаем content и reasoning_content
        const choice = data.choices?.[0];
        let finalContent = "";
        
        if (choice?.message) {
          const reasoning = choice.message.reasoning_content || "";
          const content = choice.message.content || "";
          
          if (SHOW_REASONING && reasoning) {
            finalContent = `<think>\n${reasoning}\n</think>\n\n${content}`;
          } else {
            finalContent = content;
          }
        }

        console.log("Final content length:", finalContent.length);

        // 🔥 Конвертируем в SSE-формат для Janitor AI
        const chunk = {
          id: data.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: data.created || Math.floor(Date.now() / 1000),
          model: data.model || body.model,
          choices: [{
            index: 0,
            delta: { content: finalContent },
            finish_reason: choice?.finish_reason || "stop"
          }]
        };

        const sseResponse = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
        
        return new Response(sseResponse, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });

      } catch (err) {
        console.error("Network error:", err);
        const errorSSE = `data: ${JSON.stringify({ error: { message: err.message } })}\n\ndata: [DONE]\n\n`;
        return new Response(errorSSE, {
          status: 502,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
  },
};
