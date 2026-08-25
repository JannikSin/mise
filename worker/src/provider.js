// THE AI GATEWAY (per-person-plates-design §16.2): every model call in this
// Worker goes through callModel(). The provider is env config, so swapping
// Anthropic for a local model server (Ollama / llama.cpp on the Mac Studio,
// reached via a Cloudflare Tunnel) is a config change, zero code.
//
// Contract: request bodies are ANTHROPIC MESSAGES SHAPE everywhere in this
// codebase (the build*Request helpers in lib.js), and responses are returned
// in Anthropic content-block shape everywhere (downstream parsers find
// `tool_use` blocks by name). The openai adapter translates in both
// directions at this one seam; nothing downstream ever branches on provider.
//
// Env:
//   AI_PROVIDER   "anthropic" (default) | "openai"
//   AI_BASE_URL   openai only: base URL of a /chat/completions-speaking
//                 server, e.g. https://mac-tunnel.example.com/v1
//   AI_MODEL      optional model override applied to every request
//   LOCAL_BASE_URL   OpenAI-compatible local server, tried FIRST when set
//                    (llama-server on the Mac Studio via a Cloudflare Tunnel)
//   LOCAL_MODEL      model id for that server, e.g. qwen3-vl-30b
//   LOCAL_API_KEY    optional bearer for the tunnel / llama-server --api-key
//   LOCAL_TIMEOUT_MS how long to wait before falling back (default 12000)
//   AI_API_KEY    key for the configured provider (falls back to
//                 ANTHROPIC_API_KEY for the anthropic provider)

/**
 * @param {Record<string, any>} body Anthropic Messages request
 * @param {{ AI_PROVIDER?: string, AI_BASE_URL?: string, AI_MODEL?: string, AI_API_KEY?: string, ANTHROPIC_API_KEY?: string, LOCAL_BASE_URL?: string, LOCAL_MODEL?: string, LOCAL_API_KEY?: string, LOCAL_TIMEOUT_MS?: string|number }} env
 * @returns {Promise<Record<string, any>>} Anthropic Messages response shape
 */
export async function callModel(body, env) {
  // LOCAL FIRST, then the cloud. This is the architecture the 2026-07-20 council
  // approved and that was only half-built: the OpenAI-format request builders
  // below were written, the local endpoint was never wired, so every call has
  // been going to the paid Anthropic key. Qwen3-VL was downloaded FOR this.
  //
  // The council's own words: "wrap every route in try-local-then-fallback-to-
  // Anthropic with a short timeout. The fallback is the load-bearing wall: a
  // basement has no SLA." That is exactly what this is. The Mac may be asleep,
  // rebooting, or holding the other model in memory, and a user waiting on a
  // menu scan must never pay for that.
  //
  // Opt-in by design: with LOCAL_BASE_URL unset this behaves exactly as before,
  // which keeps the council's gate intact (user-facing traffic moves local only
  // after it beats the accuracy bar on real receipts).
  if (env.LOCAL_BASE_URL) {
    const localReq = env.LOCAL_MODEL ? { ...body, model: env.LOCAL_MODEL } : body;
    try {
      const out = await callOpenAICompat(localReq, {
        AI_BASE_URL: env.LOCAL_BASE_URL,
        AI_API_KEY: env.LOCAL_API_KEY ?? "",
      }, Number(env.LOCAL_TIMEOUT_MS ?? 12000));
      if (hasUsableContent(out)) {
        console.log("callModel: served locally");
        return out;
      }
      console.log("callModel: local returned empty, falling back");
    } catch (e) {
      // Asleep, cold-loading a model, tunnel down, timeout: all the same here.
      console.log(`callModel: local unavailable (${e}), falling back`);
    }
  }

  const provider = env.AI_PROVIDER ?? "anthropic";
  const req = env.AI_MODEL ? { ...body, model: env.AI_MODEL } : body;
  if (provider === "openai") return callOpenAICompat(req, env);
  return callAnthropic(req, env.AI_API_KEY ?? env.ANTHROPIC_API_KEY ?? "");
}

/**
 * True when a response actually carries content. A local model that answers with
 * an empty string has not served the request, and silently returning that would
 * surface as a blank menu scan rather than as a fallback.
 * @param {Record<string, any>} out Anthropic-shaped response
 */
function hasUsableContent(out) {
  const blocks = out?.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.some(
    (b) => (b?.type === "text" && String(b.text ?? "").trim()) || b?.type === "tool_use",
  );
}

/** True when a key is configured for the active provider. */
export function providerConfigured(/** @type {Record<string, any>} */ env) {
  // A local endpoint alone is enough to serve, even with no cloud key at all.
  if (env.LOCAL_BASE_URL) return true;
  if ((env.AI_PROVIDER ?? "anthropic") === "openai")
    return Boolean(env.AI_BASE_URL); // local servers often need no key
  return Boolean(env.AI_API_KEY ?? env.ANTHROPIC_API_KEY);
}

/**
 * @param {Record<string, any>} body
 * @param {string} apiKey
 */
async function callAnthropic(body, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  return res.json();
}

/**
 * The local-model adapter: translate the Anthropic-shaped request to an
 * OpenAI-compatible /chat/completions call (the contract Ollama, llama.cpp
 * server and LM Studio all speak), then translate the answer BACK to
 * Anthropic content-block shape so every downstream parser works unchanged.
 * Single-shot, non-streaming on purpose (§16.2: local servers vary on
 * streaming quality; nothing in this Worker streams).
 * @param {Record<string, any>} body
 * @param {Record<string, any>} env
 */
async function callOpenAICompat(body, env, timeoutMs = 0) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: String(body.system) });
  for (const m of body.messages ?? []) {
    messages.push({ role: m.role, content: translateContent(m.content) });
  }
  /** @type {Record<string, any>} */
  const req = {
    model: body.model,
    max_tokens: body.max_tokens ?? 1024,
    messages,
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    req.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.input_schema },
    }));
    // Anthropic's forced tool choice -> OpenAI's named function form
    if (body.tool_choice?.type === "tool") {
      req.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    } else if (body.tool_choice?.type === "any") {
      req.tool_choice = "required";
    }
  }
  const base = String(env.AI_BASE_URL ?? "").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.AI_API_KEY ? { authorization: `Bearer ${env.AI_API_KEY}` } : {}),
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`ai-provider ${res.status}`);
  const out = /** @type {Record<string, any>} */ (await res.json());
  const choice = out.choices?.[0];
  /** @type {Record<string, any>[]} */
  const content = [];
  if (choice?.message?.content) content.push({ type: "text", text: String(choice.message.content) });
  for (const call of choice?.message?.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      // a local model can emit malformed JSON; an empty input falls through
      // to the same downstream "tool block absent/invalid" handling as a
      // model that never called the tool. Screens and clamps run either way.
    }
    content.push({ type: "tool_use", id: call.id ?? "", name: call.function?.name ?? "", input });
  }
  return {
    content,
    stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    model: out.model ?? body.model,
  };
}

/**
 * Anthropic content (string, or blocks incl. base64 images) -> OpenAI
 * content (string, or parts with image_url data URIs).
 * @param {any} content
 */
function translateContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts = content.map((b) => {
    if (b?.type === "image" && b.source?.type === "base64") {
      return {
        type: "image_url",
        image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
      };
    }
    return { type: "text", text: String(b?.text ?? "") };
  });
  // pure-text messages collapse to a plain string (widest local-server compat)
  return parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts;
}
