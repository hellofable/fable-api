import { OpenAI } from "openai";

const modelName = "gpt-4o-mini-tts";

function resolveOpenAIClient() {
  const key = process.env.OPENAI_API_KEY ?? "";
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

export default async function tts(req, res) {
  const openai = resolveOpenAIClient();
  if (!openai) {
    return res
      .status(500)
      .json({ error: "The OpenAI API key is not configured." });
  }

  const { text, voice = "alloy" } = req.body ?? {};
  const payload = typeof text === "string" ? text.trim() : "";

  if (!payload) {
    return res.status(400).json({ error: "Text is required." });
  }

  try {
    const mp3 = await openai.audio.speech.create({
      model: modelName,
      voice,
      format: "mp3",
      input: payload
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length.toString());
    return res.send(buffer);
  } catch (error) {
    console.error("[tts]", error);
    const message =
      error?.message ?? "The text-to-speech service could not be reached.";
    return res.status(500).json({ error: `Text-to-speech failed: ${message}` });
  }
}
