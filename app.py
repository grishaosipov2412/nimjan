import os
import json
import time
import httpx
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

app = FastAPI(title="OpenAI to NVIDIA/HF Proxy")
security = HTTPBearer()

# === КОНФИГУРАЦИЯ ===
CLIENT_API_KEY = os.getenv("CLIENT_API_KEY", "")
BACKEND_API_KEY = os.getenv("BACKEND_API_KEY", "")
API_BASE = os.getenv("API_BASE", "https://integrate.api.nvidia.com/v1")
SHOW_REASONING = os.getenv("SHOW_REASONING", "true").lower() == "true"

VALID_EFFORTS = {"minimal", "low", "medium", "high", "extra-high", "extra_high", "extrahigh", "max", "none", "off", "disabled"}

def normalize_effort(value):
    if not isinstance(value, str):
        return None
    v = value.strip().lower().replace(" ", "-")
    return v if v in VALID_EFFORTS else None

# === ЗАЩИТА ===
async def verify_client_key(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if not CLIENT_API_KEY:
        raise HTTPException(status_code=500, detail="CLIENT_API_KEY not set in environment")
    if credentials.credentials != CLIENT_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return True

@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "OpenAI Proxy",
        "reasoning_display": SHOW_REASONING,
        "supported_efforts": sorted(list(VALID_EFFORTS - {"off", "none", "disabled"}))
    }

@app.get("/v1/models", dependencies=[Depends(verify_client_key)])
async def list_models():
    return {
        "object": "list",
        "data": [{"id": "custom-model", "object": "model", "created": int(time.time()), "owned_by": "proxy"}]
    }

@app.post("/v1/chat/completions", dependencies=[Depends(verify_client_key)])
async def chat_completions(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    
    model = body.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="Parameter 'model' is required")
        
    messages = body.get("messages", [])
    temperature = body.get("temperature", 0.6)
    max_tokens = body.get("max_tokens", 4096)
    stream = body.get("stream", False)
    
    client_thinking = body.get("thinking", False)
    client_effort_raw = body.get("reasoning_effort")
    effort = normalize_effort(client_effort_raw)
    
    backend_request = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream
    }
    
    effort_off = effort in ("off", "none", "disabled")
    thinking_enabled = (client_thinking is True and not effort_off) or (effort is not None and not effort_off)
    
    if thinking_enabled:
        extra_body = body.get("extra_body", {})
        chat_kwargs = extra_body.get("chat_template_kwargs", {})
        chat_kwargs["thinking"] = True
        if effort:
            chat_kwargs["reasoning_effort"] = effort
            extra_body["reasoning_effort"] = effort
        extra_body["chat_template_kwargs"] = chat_kwargs
        backend_request["extra_body"] = extra_body

    headers = {
        "Authorization": f"Bearer {BACKEND_API_KEY}",
        "Content-Type": "application/json"
    }

    if not stream:
        async with httpx.AsyncClient() as client:
            response = await client.post(f"{API_BASE}/chat/completions", json=backend_request, headers=headers, timeout=120.0)
            if response.status_code >= 400:
                raise HTTPException(status_code=response.status_code, detail=response.text)
            
            data = response.json()
            choices = []
            for choice in data.get("choices", []):
                content = choice.get("message", {}).get("content", "")
                reasoning = choice.get("message", {}).get("reasoning_content", "")
                if SHOW_REASONING and reasoning:
                    content = f"<think>\n{reasoning}\n</think>\n\n{content}"
                choices.append({
                    "index": choice.get("index", 0),
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": choice.get("finish_reason", "stop")
                })
            return {
                "id": f"chatcmpl-{int(time.time())}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": choices,
                "usage": data.get("usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
            }
    else:
        async def event_generator():
            reasoning_started = False
            async with httpx.AsyncClient() as client:
                async with client.stream("POST", f"{API_BASE}/chat/completions", json=backend_request, headers=headers, timeout=120.0) as response:
                    if response.status_code >= 400:
                        error_text = await response.aread()
                        yield f"data: {json.dumps({'error': error_text.decode()})}\n\n"
                        return
                    
                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            if line.strip() == "data: [DONE]":
                                yield "data: [DONE]\n\n"
                                continue
                            try:
                                data = json.loads(line[6:])
                                choices = data.get("choices", [])
                                if not choices:
                                    continue
                                delta = choices[0].get("delta", {})
                                reasoning = delta.get("reasoning_content")
                                content = delta.get("content")
                                
                                if SHOW_REASONING:
                                    combined_content = ""
                                    if reasoning and not reasoning_started:
                                        combined_content = "<think>\n" + reasoning
                                        reasoning_started = True
                                    elif reasoning:
                                        combined_content = reasoning
                                    
                                    if content and reasoning_started:
                                        combined_content += "\n</think>\n\n" + content
                                        reasoning_started = False
                                    elif content:
                                        combined_content += content
                                        
                                    if combined_content:
                                        delta["content"] = combined_content
                                    if "reasoning_content" in delta:
                                        del delta["reasoning_content"]
                                else:
                                    delta["content"] = content if content else ""
                                    if "reasoning_content" in delta:
                                        del delta["reasoning_content"]
                                
                                data["choices"][0]["delta"] = delta
                                yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
                            except json.JSONDecodeError:
                                pass
                        elif line.strip():
                            yield f"{line}\n"
        return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port)
