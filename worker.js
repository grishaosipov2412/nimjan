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

      const isLargeModel = /120b|405b|70b/i.test(body.model);
      const timeout = isLargeModel ? 180000 : 120000;

      const nimRequest = {
        model: body.model,
        messages: processedMessages,
        temperature: body.temperature !== undefined ? body.temperature : 0.7,
        max_tokens: body.max_tokens || 1024,
        stream: true,
      };

      if (body.thinking || body.reasoning_effort) {
        const effort = body.reasoning_effort || "medium";
        if (!["off", "none", "disabled"].includes(String(effort).toLowerCase())) {
          nimRequest.thinking = true;
          nimRequest.reasoning_effort = effort;
        }
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${BACKEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(nimRequest),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const streamHeaders = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        };

        // Обработка ошибок
        if (!response.ok) {
          const errorText = await response.text();
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch (e) {
            errorData = { error: { message: errorText.substring(0, 500) } };
          }
          const errorSSE = `data: ${JSON.stringify(errorData)}\n\ndata: [DONE]\n\n`;
          return new Response(errorSSE, { status: response.status, headers: streamHeaders });
        }

        // 🔥 КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: читаем поток, парсим каждый чанк,
        // копируем reasoning_content -> content, отправляем дальше.
        if (body.stream) {
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
                    // Отправляем финальный [DONE]
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    break;
                  }

                  buffer += decoder.decode(value, { stream: true });
                  
                  // Обрабатываем все полные SSE-сообщения в буфере
                  let newlineIndex;
                  while ((newlineIndex = buffer.indexOf("\n\n")) !== -1) {
                    const message = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 2);

                    if (!message || message.startsWith(":")) continue; // комментарии SSE

                    if (message.startsWith("data: ")) {
                      const dataStr = message.slice(6).trim();
                      
                      if (dataStr === "[DONE]") {
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        continue;
                      }

                      try {
                        const chunk = JSON.parse(dataStr);
                        
                        // 🔥 Переносим reasoning_content в content для Janitor AI
                        if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
                          const delta = chunk.choices[0].delta;
                          if (delta.reasoning_content) {
                            // Копируем reasoning в content (Janitor AI ждёт именно content)
                            delta.content = delta.reasoning_content;
                            // Можно удалить reasoning_content, чтобы не дублировать
                            delete delta.reasoning_content;
                          }
                        }

                        // Отправляем обработанный чанк
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                      } catch (e) {
                        // Если не JSON — отправляем как есть
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
            headers: streamHeaders,
          });
        }

        // Не-стриминг (на всякий случай)
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
        
      } catch (err) {
        const isTimeout = err.name === 'AbortError';
        const errorResponse = { 
          error: { 
            message: isTimeout 
              ? `Model ${body.model} timed out after ${timeout/1000}s.`
              : "Network error: " + err.message 
          } 
        };
        const errorSSE = `data: ${JSON.stringify(errorResponse)}\n\ndata: [DONE]\n\n`;
        return new Response(errorSSE, {
          status: isTimeout ? 504 : 502,
          headers: streamHeaders
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found: " + pathname }), {
      status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  },
};
