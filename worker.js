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
        show_reasoning: SHOW_REASONING,
        config: { BACKEND_API_KEY_set: !!BACKEND_API_KEY, CLIENT_API_KEY_set: !!CLIENT_API_KEY }
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Models
    if (pathname === "/v1/models" && request.method === "GET") {
      if (!checkKey(request, CLIENT_API_KEY)) return unauthorized();
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "custom-model", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "proxy" }]
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Chat completions
    if (pathname === "/v1/chat/completions" && request.method === "POST") {
      if (!BACKEND_API_KEY || !CLIENT_API_KEY) {
        return new Response(JSON.stringify({ error: "Server config error: Keys missing" }), { status: 500 });
      }
      if (!checkKey(request, CLIENT_API_KEY)) return unauthorized();

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
      }

      if (!body.model || !body.messages || !body.messages.length) {
        return new Response(JSON.stringify({ error: "Missing model or messages" }), { status: 400 });
      }

      const wantStream = body.stream !== undefined ? body.stream : true;

      const nimRequest = {
        model: body.model,
        messages: body.messages,
        temperature: body.temperature !== undefined ? body.temperature : 0.7,
        max_tokens: body.max_tokens || 1024,
        stream: wantStream,
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

        if (!response.ok) {
          const errorText = await response.text();
          console.log("NVIDIA ERROR:", response.status, errorText);
          if (wantStream) {
            const sse = `data: ${JSON.stringify({ error: { message: errorText } })}\n\ndata: [DONE]\n\n`;
            return new Response(sse, { status: response.status, headers: { "Content-Type": "text/event-stream" } });
          }
          return new Response(errorText, { status: response.status, headers: { "Content-Type": "application/json" } });
        }

        // === НЕ-СТРИМИНГ: читаем JSON, склеиваем reasoning + content ===
        if (!wantStream) {
          const data = await response.json();
          const choice = data.choices?.[0];
          if (choice?.message) {
            const reasoning = choice.message.reasoning_content || "";
            const content = choice.message.content || "";
            let final = content;
            if (SHOW_REASONING && reasoning) {
              final = `<think>\n${reasoning}\n</think>\n\n${content}`;
            }
            choice.message.content = final;
            delete choice.message.reasoning_content;
          }
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // === СТРИМИНГ: читаем SSE от NVIDIA и переупаковываем в OpenAI-формат ===
        // Ключевое исправление: NVIDIA кладёт текст reasoning-моделей в delta.reasoning_content.
        // Мы переносим его в delta.content, оборачивая в <think>...</think>, чтобы клиент видел текст.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          async start(controller) {
            let buffer = '';
            let reasoningStarted = false;
            let reasoningEnded = false;
            let lastId = `chatcmpl-${Date.now()}`;
            let lastModel = body.model;
            let lastCreated = Math.floor(Date.now() / 1000);

            const send = (obj) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed || !trimmed.startsWith('data:')) continue;

                  const data = trimmed.slice(5).trim();
                  if (data === '[DONE]') {
                    // Закрываем <think>, если reasoning остался незакрытым
                    if (SHOW_REASONING && reasoningStarted && !reasoningEnded) {
                      send({
                        id: lastId, object: "chat.completion.chunk", created: lastCreated, model: lastModel,
                        choices: [{ index: 0, delta: { content: "\n</think>\n\n" }, finish_reason: null }]
                      });
                    }
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    continue;
                  }

                  let chunk;
                  try {
                    chunk = JSON.parse(data);
                  } catch (e) {
                    console.error("Bad chunk:", data.substring(0, 100));
                    continue;
                  }

                  if (chunk.id) lastId = chunk.id;
                  if (chunk.model) lastModel = chunk.model;
                  if (chunk.created) lastCreated = chunk.created;

                  const choice = chunk.choices?.[0];
                  if (!choice) continue;

                  const delta = choice.delta || {};
                  const reasoning = delta.reasoning_content || "";
                  const content = delta.content || "";

                  // Собираем текст в delta.content для OpenAI-формата
                  let outContent = "";

                  if (SHOW_REASONING) {
                    if (reasoning) {
                      if (!reasoningStarted) {
                        outContent += "<think>\n" + reasoning;
                        reasoningStarted = true;
                      } else {
                        outContent += reasoning;
                      }
                    }
                    if (content) {
                      if (reasoningStarted && !reasoningEnded) {
                        outContent += "\n</think>\n\n" + content;
                        reasoningEnded = true;
                      } else {
                        outContent += content;
                      }
                    }
                  } else {
                    // Без показа reasoning: просто отдаём content, reasoning игнорируем
                    outContent = content;
                  }

                  // Если ничего нет и finish_reason тоже нет — пропускаем пустой чанк
                  if (!outContent && !choice.finish_reason) continue;

                  send({
                    id: lastId,
                    object: "chat.completion.chunk",
                    created: lastCreated,
                    model: lastModel,
                    choices: [{
                      index: 0,
                      delta: { content: outContent },
                      finish_reason: choice.finish_reason || null
                    }]
                  });
                }
              }
              controller.close();
            } catch (e) {
              console.error("Stream error:", e);
              controller.close();
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

      } catch (err) {
        console.error("Network error:", err);
        if (wantStream) {
          const sse = `data: ${JSON.stringify({ error: { message: err.message } })}\n\ndata: [DONE]\n\n`;
          return new Response(sse, { status: 502, headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({ error: err.message }), { status: 502 });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
  },
};

function checkKey(request, clientKey) {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${clientKey}`;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Invalid API key" }), {
    status: 401, headers: { "Content-Type": "application/json" }
  });
}
