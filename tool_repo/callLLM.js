const { default: Conversation } = require('./conversation');
const { jsonValidator } = require('./jsonValidator');

class CallLLMTool {
  static name = 'callLLM';
  static methodSignature = 'callLLM(params: { prompt: string, system_prompt?: string, model?: string, responseFormat?: string, resultVar?: string }[]): any';
  static description = 'Call the LLM with the given system prompt and prompt, optionally specifying the model and response format and setting a result variable.';

  static async execute(params, api) {
    if (!Array.isArray(params)) params = [params];
    for (const param of params) {
      let { prompt, system_prompt, model, responseFormat, resultVar } = param;
      try {
        if (!prompt) {
          throw new Error("Both 'prompt' and 'system_prompt' are required parameters for the 'callLLM' tool.");
        }
        if (!system_prompt) system_prompt = prompt;
        model = model || 'claude';
        if (model !== 'claude' && model !== 'gemini') {
          throw new Error("Invalid model specified. Choose either 'claude' or 'gemini'.");
        }
        if (responseFormat) {
          system_prompt = `${system_prompt}. Response Format: You MUST respond with a JSON - encoded string in the following format: \n\`\`\`typescript\n${responseFormat}\n\`\`\`\n`;
        }
        const convo = new Conversation(model);
        const response = await convo.chat([
          {
            role: 'system',
            content: system_prompt,
          },
          {
            role: 'user',
            content: prompt,
          },
        ]);
        const data = response.content[0].text.trim();
        if (responseFormat) {
          try {
            const isValidJson = jsonValidator(responseFormat, data);
            if (!isValidJson) {
              throw new Error('Invalid JSON structure in LLM response. Actual response: ' + data + ' Expected response format: ' + responseFormat);
            }
            const rr = JSON.parse(data);
            if (resultVar) {
              api.store[resultVar] = rr;
            }
            return rr;
          } catch (error) {
            api.emit('error', `JSON parsing failed for LLM response: ${data}`);
            if (resultVar) {
              api.store[resultVar] = data;
            }
            return data;
          }
        } else {
          if (resultVar) {
            api.store[resultVar] = data;
          }
          return data;
        }
      } catch (error) {
        const llmResponse = await api.callTool('callLLM', {
          system_prompt: 'Analyze the provided error details and generate a fix or provide guidance on resolving the issue.',
          prompt: JSON.stringify({
            error: error.message,
            stackTrace: error.stack,
            context: { prompt, system_prompt, model, responseFormat, resultVar },
          }),
        });
        if (llmResponse.fix) {
          return llmResponse.fix;
        }
        throw error;
      }
    }
  }
}

module.exports = CallLLMTool;