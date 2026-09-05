import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * Neural text-to-speech for the voice/Jarvis features. Proxies to the on-box
 * Kokoro-FastAPI service (OpenAI-compatible `/v1/audio/speech`), so the audio is
 * synthesized locally — no API key, no per-use cost, and the terminal text never
 * leaves the machine. The client (`src/lib/tts.ts`) plays the returned MP3 through
 * Web Audio, which also lets the Jarvis orb react to a REAL spectrum.
 *
 * If the service is down we return 503 and the client falls back to the browser's
 * Web Speech synthesizer, so voice never hard-fails.
 *
 * `KOKORO_URL` overrides the upstream (default: the local container on :8880).
 * OpenAI-compatible on purpose: swapping to a hosted voice later is a URL + key.
 */
export const dynamic = "force-dynamic";

const KOKORO_URL = process.env.KOKORO_URL ?? "http://127.0.0.1:8880";
const noStore = { "Cache-Control": "no-store" };

const bodySchema = z.object({
  text: z.string().min(1).max(800),
  voice: z.string().min(1).max(40).default("bm_george"),
  speed: z.number().min(0.5).max(2).default(1),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400, headers: noStore },
    );
  }
  const { text, voice, speed } = parsed.data;

  try {
    const upstream = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kokoro",
        voice,
        input: text,
        response_format: "mp3",
        speed,
      }),
      // Generous cap for a long sentence on CPU; still under nginx's 60s.
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `tts upstream ${upstream.status}` },
        { status: 503, headers: noStore },
      );
    }

    // Stream the audio straight through — no buffering the whole clip in the route.
    return new Response(upstream.body, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (e) {
    // Service unreachable / timeout → 503 so the client falls back to Web Speech.
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 503, headers: noStore },
    );
  }
}
