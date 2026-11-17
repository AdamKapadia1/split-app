export const VisionService = {
  async analyzeReceipt(base64: string) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY as string,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5-5',
          max_tokens: 1000,
          system: "You are a raw data extraction API. Return ONLY a valid JSON object. Do not include markdown blocks (```json). Do not include introductory text. All prices and totals must be raw floats (e.g., 3.80) with NO currency symbols (£, $, etc). Schema: { \"items\": [{ \"name\": \"string\", \"price\": number }], \"subtotal\": number, \"tax\": number, \"total\": number }",
          messages: [{
            role: 'user',
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: base64 }
            }]
          }]
        })
      });

      const responseText = await response.text();
      console.log("🔍 FULL HTTP RESPONSE:", responseText);

      const data = JSON.parse(responseText);

      if (!response.ok || data.error) {
        throw new Error(data.error?.message || `HTTP error! status: ${response.status}`);
      }

      const rawText = data.content?.[0]?.text || JSON.stringify(data);
      console.log("Raw LLM Output:", rawText);
      

      // Extract everything between the first '{' and the last '}'
      const startIndex = rawText.indexOf('{');
      const endIndex = rawText.lastIndexOf('}');

      if (startIndex === -1 || endIndex === -1) {
        throw new Error("No JSON object found in the LLM response.");
      }

      const cleanText = rawText.substring(startIndex, endIndex + 1);
      return JSON.parse(cleanText);

    } catch (error) {
      console.error("Vision API Error:", error);
      throw error;
    }
  }
};