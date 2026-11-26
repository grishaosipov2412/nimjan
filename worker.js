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

    if (!BACKEND_API_KEY || !CLIENT_API_KEY) {
      return new Response(JSON.stringify({ error: "Keys missing" }), { status: 500 });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || authHeader !== `Bearer ${CLIENT_API_KEY}`) {
      return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
    }

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
          const errorSSE = `data: ${JSON.stringify({error: {message: errorText}})}\n\ndata: [DONE]\n\n`;
          return new Response(errorSSE, {
            status: response.status,
            headers: { "Content-Type": "text/event-stream" }
          });
        }

        // 🔥 Читаем SSE от NVIDIA и переупаковываем в формат OpenAI
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        
        const stream = new ReadableStream({
          async start(controller) {
            let buffer = '';
            
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed || !trimmed.startsWith('data: ')) continue;
                  
                  const data = trimmed.slice(6).trim();
                  if (data === '[DONE]') {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    continue;
                  }
                  
                  try {
                    const chunk = JSON.parse(data);
                    
                    // Переупаковываем в стандартный формат OpenAI
                    const openaiChunk = {
                      id: chunk.id || `chatcmpl-${Date.now()}`,
                      object: "chat.completion.chunk",
                      created: chunk.created || Math.floor(Date.now() / 1000),
                      model: chunk.model || body.model,
                      choices: (chunk.choices || []).map(choice => ({
                        index: choice.index || 0,
                        delta: {
                          content: choice.delta?.content || choice.message?.content || ''
                        },
                        finish_reason: choice.finish_reason || null
                      }))
                    };
                    
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                  } catch (e) {
                    console.error("Failed to parse chunk:", e);
                  }
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
        const errorSSE = `data: ${JSON.stringify({error: {message: err.message}})}\n\ndata: [DONE]\n\n`;
        return new Response(errorSSE, {
          status: 502,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
  },
};
