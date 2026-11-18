export const VisionService = {
  async analyzeReceipt(base64: string) {
    try {
      console.log("🚀 Sending receipt to Anthropic Vision API...");

      const cleanBase64 = base64.replace(/^data:image\/(jpeg|png|jpg);base64,/, '');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY as string,
          'anthropic-version': '2026-10-21',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5-5',
          max_tokens: 1000,
          thinking: { type: 'between_tools' },
          system: "You are a raw data extraction API. Return ONLY a valid JSON object. Do not include markdown blocks. All prices and totals must be raw floats (e.g., 3.80) with NO currency symbols. CRITICAL: Read the receipt strictly from top to bottom, line by line. You MUST preserve the exact original layout order of the items. merchant_name: look at the top logo, header, address block, or footer for the business name. Clean it into a readable display name (for example, convert \"MOLLIES MOTEL & DINER LTD #04\" to \"Mollie's\", or \"TESCO STORES 2314\" to \"Tesco\"). Return null only when no business name is visible at all. Schema: { \"merchant_name\": string | null, \"website\": string | null, \"items\": [{ \"name\": \"string\", \"price\": number }], \"subtotal\": number, \"tax\": number, \"total\": number }",
          messages: [{
            role: 'user',
            content: [{
              type: 'image',
              source: { 
                type: 'base64', 
                media_type: 'image/jpeg', 
                data: cleanBase64 
              }
            }]
          }]
        })
      });

      const responseText = await response.text();
      const data = JSON.parse(responseText);

      if (!response.ok || data.error) {
        throw new Error(data.error?.message || `HTTP error! status: ${response.status}`);
      }

      const rawText = data.content?.[0]?.text || JSON.stringify(data);
      
      const startIndex = rawText.indexOf('{');
      const endIndex = rawText.lastIndexOf('}');

      if (startIndex === -1 || endIndex === -1) {
        throw new Error("No JSON object found in the LLM response.");
      }

      const cleanText = rawText.substring(startIndex, endIndex + 1);
      const parsed = JSON.parse(cleanText);
      return {
        ...parsed,
        merchant_name: readMerchantName(parsed),
      };

    } catch (error) {
      console.error("🚨 Vision API Error:", error);
      throw error;
    }
  }
};

function readMerchantName(parsed: { merchant_name?: unknown; restaurantName?: unknown; restaurant_name?: unknown }) {
  const raw = parsed.merchant_name ?? parsed.restaurantName ?? parsed.restaurant_name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.toLowerCase() === 'null') return null;
  return name;
}