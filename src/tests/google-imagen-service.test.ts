import "./setup/environment-mock";
import { GoogleGenAIImageService } from "@/ai/providers/google-genai/image.js";

describe("GoogleGenAIImageService (Legacy REST fallback)", () => {
  beforeEach(() => {
    process.env.GOOGLE_GENAI_FORCE_REST = 'true';
    process.env.GOOGLE_GENAI_DISABLE_IMAGEN_MAPPING = 'true';
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generatedImages: [ { image: { imageBytes: Buffer.from('test').toString('base64') } } ]
      })
    });
  });

  it("generates image via legacy REST when forced", async () => {
    const service = new GoogleGenAIImageService({ apiKey: "key", model: 'imagen-4.0-fast-generate-001' });
    const buffer = await service.generate("a prompt");
    expect(buffer.toString()).toBe("test");
    expect(global.fetch).toHaveBeenCalled();
  });
});
