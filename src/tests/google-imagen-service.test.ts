import "./setup/environment-mock";
import { GoogleGenAIImageService } from "@/ai/providers/google-genai/image.js";

describe("GoogleGenAIImageService", () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generatedImages: [
          { image: { imageBytes: Buffer.from("test").toString("base64") } },
        ],
      }),
    });
  });

  it("generates an image using defaults", async () => {
    const service = new GoogleGenAIImageService({ apiKey: "key" });
    const buffer = await service.generate("a prompt");
    expect(buffer.toString()).toBe("test");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("imagen-4.0-ultra-generate-001"),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse((fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.config.numberOfImages).toBe(1);
    expect(body.config.sampleImageSize).toBe("2K");
    expect(body.config.aspectRatio).toBe("3:4");
    expect(body.config.personGeneration).toBe("allow_all");
  });
});
