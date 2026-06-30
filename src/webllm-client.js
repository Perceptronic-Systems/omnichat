import { CreateMLCEngine } from "@mlc-ai/web-llm";

export const WEBLLM_MODEL_ID = "Qwen3-0.6B-q4f16_1-MLC";

let enginePromise = null;

export function isWebGPUAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

// Returns a singleton engine, downloading/compiling the model on first call.
// onProgress receives { progress: 0-1, text: "..." } updates for a loading bar.
export function getEngine(onProgress) {
  if (!enginePromise) {
    console.log(`[webllm] Loading model: ${WEBLLM_MODEL_ID}`);
    enginePromise = CreateMLCEngine(WEBLLM_MODEL_ID, {
      initProgressCallback: (p) => {
        console.log(`[webllm] ${p.text} (${Math.round(p.progress * 100)}%)`);
        onProgress?.(p);
      },
    });
  }
  return enginePromise;
}

function stripThink(text) {
  // Defensive cleanup in case the model ever emits empty <think></think> tags
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
}

export async function* generateResponseWebLLM(prompt, history = []) {
  if (!isWebGPUAvailable()) {
    throw new Error(
      "WebGPU isn't available in this browser. Try the latest Chrome or Edge on desktop."
    );
  }

  // ── Surface model-loading progress as status-only yields ──────────────────
  let latestProgress = null;
  let engineReady = false;

  const enginePromise = getEngine((p) => { latestProgress = p; })
    .then(engine => { engineReady = true; return engine; });

  while (!engineReady) {
    const pct = latestProgress?.progress != null ? Math.round(latestProgress.progress * 100) : null;
    const text = latestProgress?.text || "Loading model";
    yield {
      token: "",
      status: pct != null ? `${text} (${pct}%)` : text,
      tool_calls: null,
    };
    await new Promise(r => setTimeout(r, 200));
  }

  const engine = await enginePromise;

  // ── Generate, stripping <think>...</think> safely across chunk boundaries ──
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: `${prompt}\n/no_think` },
  ];

  const stream = await engine.chat.completions.create({
    model: WEBLLM_MODEL_ID,
    messages,
    stream: true,
  });

  let raw = "";
  let emittedLen = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    if (!delta) continue;
    raw += delta;

    // Drop fully-closed <think>...</think> blocks
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
    // Hide a still-open/unclosed <think> tag while it's mid-stream
    const openIdx = cleaned.indexOf("<think>");
    if (openIdx !== -1) cleaned = cleaned.slice(0, openIdx);

    if (cleaned.length > emittedLen) {
      const newText = cleaned.slice(emittedLen);
      emittedLen = cleaned.length;
      yield { token: newText, status: "Generating", tool_calls: null };
    }
  }
}