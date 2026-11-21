# NVIDIA NIM Proxy

OpenAI-compatible proxy for NVIDIA NIM API, deployed on Cloudflare Workers.

## Features

- ✅ Full OpenAI API compatibility (`/v1/chat/completions`, `/v1/models`)
- ✅ API key protection
- ✅ Streaming support (SSE)
- ✅ Dynamic thinking/reasoning control
- ✅ 24/7 uptime, never sleeps
- ✅ Free tier: 100,000 requests/day

## Setup

1. Deploy to Cloudflare Workers
2. Set environment variables:
   - `BACKEND_API_KEY`: Your NVIDIA API key
   - `CLIENT_API_KEY`: Your custom client key
3. Use the Worker URL as Base URL in your client

## Usage

**Base URL:** `https://nim-proxy.your-account.workers.dev`

**API Key:** Your `CLIENT_API_KEY`

**Model:** Any NVIDIA NIM model (e.g., `deepseek-ai/deepseek-r1`)

### Example with thinking

```json
{
  "model": "deepseek-ai/deepseek-r1",
  "messages": [{"role": "user", "content": "Solve this"}],
  "thinking": true,
  "reasoning_effort": "high"
}
