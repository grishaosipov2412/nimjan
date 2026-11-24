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

      const nimRequest = {
        model: body.model,
        messages: body.messages,
        temperature: body.temperature !== undefined ? body.temperature : 0.7,
        max_tokens: body.max_tokens || 1024,
        stream: body.stream !== undefined ? body.stream : false, // По умолчанию БЕЗ стриминга
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

        // Обработка ошибок от NVIDIA
        if (!response.ok) {
          const errorText = await response.text();
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch (e) {
            errorData = { error: { message: errorText.substring(0, 300) } };
          }
          return new Response(JSON.stringify(errorData), {
            status: response.status,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
          });
        }

        // 🔥 УМНАЯ ОБРАБОТКА СТРИМИНГА
        if (body.stream) {
          // Если клиент хочет стриминг - пробрасываем поток напрямую
          return new Response(response.body, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        } else {
          // Если клиент НЕ хочет стриминг - собираем SSE-поток и возвращаем финальный JSON
          const responseText = await response.text();
          
          // Парсим SSE-поток
          const lines = responseText.split('\n').filter(line => line.trim() !== '');
          let finalContent = '';
          let finalResponse = null;

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              
              if (data === '[DONE]') {
                break;
              }

              try {
                const chunk = JSON.parse(data);
                
                // Собираем контент из всех chunks
                if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
                  const delta = chunk.choices[0].delta;
                  if (delta.content) {
                    finalContent += delta.content;
                  }
                }

                // Сохраняем последний chunk для метаданных
                if (chunk.id) {
                  finalResponse = chunk;
                }
              } catch (e) {
                // Пропускаем невалидный JSON
              }
            }
          }

          // Формируем финальный ответ в формате OpenAI
          if (finalResponse) {
            finalResponse.choices = [{
              index: 0,
              message: {
                role: 'assistant',
                content: finalContent
              },
              finish_reason: 'stop'
            }];
            finalResponse.object = 'chat.completion';
          } else {
            // Если не удалось распарсить, возвращаем минимальный ответ
            finalResponse = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: finalContent || 'No response generated'
                },
                finish_reason: 'stop'
              }],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
              }
            };
          }

          return new Response(JSON.stringify(finalResponse), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        
      } catch (err) {
        return new Response(JSON.stringify({ error: "Network error to upstream: " + err.message }), {
          status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found: " + pathname }), {
      status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  },
};
