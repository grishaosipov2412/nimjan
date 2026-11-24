export default {
  async fetch(request, env) {
    const BACKEND_API_KEY = env.BACKEND_API_KEY;
    const CLIENT_API_KEY = env.CLIENT_API_KEY;
    const API_BASE = "https://integrate.api.nvidia.com/v1";
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, ""); 

    // 1. CORS
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

    // 2. Health check
    if (pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "CF Worker Proxy",
        config: { BACKEND_API_KEY_set: !!BACKEND_API_KEY, CLIENT_API_KEY_set: !!CLIENT_API_KEY }
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 3. Проверка ключей
    if (!BACKEND_API_KEY || !CLIENT_API_KEY) {
      return new Response(JSON.stringify({ error: "Server config error: Keys missing" }), {
        status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 4. Проверка ключа клиента
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${CLIENT_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
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

      if (!body.model || !body.messages || body.messages.length === 0) {
        return new Response(JSON.stringify({ error: "Parameter 'model' and non-empty 'messages' are required" }), {
          status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Автоконвертация для VL-моделей
      const isVLModel = /vl|vision|multimodal/i.test(body.model);
      let processedMessages = body.messages;
      if (isVLModel) {
        processedMessages = body.messages.map(msg => {
          if (typeof msg.content === "string") {
            return { ...msg, content: [{ type: "text", text: msg.content }] };
          }
          return msg;
        });
      }

      const isLargeModel = /120b|405b|70b|550b/i.test(body.model);
      const timeout = isLargeModel ? 180000 : 120000;

      // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: строго соблюдаем stream-настройку клиента!
      const clientWantsStream = body.stream === true;

      const nimRequest = {
        model: body.model,
        messages: processedMessages,
        temperature: body.temperature !== undefined ? body.temperature : 0.7,
        max_tokens: body.max_tokens || 1024,
        stream: clientWantsStream, 
      };

      if (body.thinking || body.reasoning_effort) {
        const effort = body.reasoning_effort || "medium";
        if (!["off", "none", "disabled"].includes(String(effort).toLowerCase())) {
          nimRequest.thinking = true;
          nimRequest.reasoning_effort = effort;
        }
      }

      const payload = JSON.stringify(nimRequest);

      // Retry-логика для временных сбоев NVIDIA (502, 503, 504, 429)
      const MAX_RETRIES = 3;
      const RETRY_STATUSES = [502, 503, 504, 429];
      let response = null;
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          response = await fetch(`${API_BASE}/chat/completions`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${BACKEND_API_KEY}`, "Content-Type": "application/json" },
            body: payload,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok || !RETRY_STATUSES.includes(response.status)) break;

          const errorBody = await response.text();
          lastError = { status: response.status, body: errorBody };
          if (attempt === MAX_RETRIES) break;

          await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt - 1), 10000)));
        } catch (err) {
          clearTimeout(timeoutId);
          lastError = { status: err.name === 'AbortError' ? 504 : 502, body: JSON.stringify({ error: err.message }) };
          if (attempt === MAX_RETRIES) break;
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }

      // Обработка финальной ошибки после ретраев
      if (!response || !response.ok) {
        const status = response ? response.status : (lastError?.status || 502);
        let errorText = response ? await response.text() : (lastError?.body || '{"error":{"message":"upstream unavailable"}}');
        let errorData;
        try { errorData = JSON.parse(errorText); } catch (e) {
          errorData = { error: { message: `NVIDIA API unavailable. ${errorText.substring(0, 200)}` } };
        }
        
        if (clientWantsStream) {
          return new Response(`data: ${JSON.stringify(errorData)}\n\ndata: [DONE]\n\n`, {
            status, headers: { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" }
          });
        }
        return new Response(JSON.stringify(errorData), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }

      // 🔥 Если клиент НЕ просил стриминг, возвращаем обычный JSON
      if (!clientWantsStream) {
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // 🔥 Если клиент просил стриминг, читаем поток и конвертируем reasoning_content -> content
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              let newlineIndex;
              while ((newlineIndex = buffer.indexOf("\n\n")) !== -1) {
                const message = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 2);
                if (!message || message.startsWith(":")) continue;

                if (message.startsWith("data: ")) {
                  const dataStr = message.slice(6).trim();
                  if (dataStr === "[DONE]") {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    continue;
                  }
                  try {
                    const chunk = JSON.parse(dataStr);
                    if (chunk.choices?.[0]?.delta) {
                      const delta = chunk.choices[0].delta;
                      // Конвертация для Janitor AI
                      if (delta.reasoning_content) {
                        delta.content = delta.reasoning_content;
                        delete delta.reasoning_content;
                      }
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  } catch (e) {
                    controller.enqueue(encoder.encode(`${message}\n\n`));
                  }
                } else {
                  controller.enqueue(encoder.encode(`${message}\n\n`));
                }
              }
            }
          } catch (err) {
            controller.error(err);
          }
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response(JSON.stringify({ error: "Not Found: " + pathname }), {
      status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  },
};
