import "dotenv/config";
import { EventEmitter } from "eventemitter3";
import { ErrorLogger } from './errorLogger';
import Conversation from './conversation';
import { VM, VMScript } from 'vm2';
import { tools as importedTools } from './tools';

import { MemoryStore } from './memory/store';
import { ConfidenceCalculator } from './memory/confidence';
import { ChromaClient } from 'chromadb';
import fs from "fs";
import path from "path";
import { Tool } from "./tool_registry";
import { log, setLogLevel, toggleService } from '../logger';

interface Memory {
  input: string;
  response: string;
  confidence: number;
  adjustedConfidence?: number;
  usedTools: string[];
}

const errorLogger = new ErrorLogger('error.log');

export default class Assistant extends EventEmitter {

  public memoryStore: MemoryStore;
  public confidenceCalculator: ConfidenceCalculator;

  public chatWindow: any;
  public apiKey: string = process.env.ANTHROPIC_API_KEY || '';
  public vscode: any;

  store: any;

  private globalRetryCount: number = 0;
  private globalRetryLimit: number = 100;

  protected conversation: Conversation;
  protected errorLogger: ErrorLogger = errorLogger;

  public working = false;
  public debug = false;
  public history: string[] = [];
  public savedOutput = '';

  constructor(public toolRegistry: any, public chromaClient: ChromaClient) {
    super();
    this.store = {};
    this.conversation = new Conversation('claude');
    this.memoryStore = new MemoryStore(chromaClient);
    this.confidenceCalculator = new ConfidenceCalculator();

    this.ensureToolsDirectory();

    setLogLevel('info');
    toggleService('Assistant', true);

    this.callScript = this.callScript.bind(this);
    this.considerAddingAsTool = this.considerAddingAsTool.bind(this);
    this.executeScript = this.executeScript.bind(this);
    this.extractErrorLine = this.extractErrorLine.bind(this);
    this.extractJson = this.extractJson.bind(this);
    this.promptUser = this.promptUser.bind(this);
    this.retryOperation = this.retryOperation.bind(this);
    this.updateMemoryConfidence = this.updateMemoryConfidence.bind(this);
    this.callAgent = this.callAgent.bind(this);
    this.callTool = this.callTool.bind(this);
    
  }

  private ensureToolsDirectory() {
    const toolsDir = path.join(__dirname, 'tools');
    if (!fs.existsSync(toolsDir)) {
      fs.mkdirSync(toolsDir, { recursive: true });
    }
  }

  private logError(message: string) {
    log('error', message, 'Assistant');
  }

  private logInfo(message: string) {
    log('info', message, 'Assistant');
  }

  private logWarn(message: string) {
    log('warn', message, 'Assistant');
  }

  private logDebug(message: string) {
    log('debug', message, 'Assistant');
  }

  async getToolRegistryReport(): Promise<string> {
    return await this.toolRegistry.generateReport();
  }

  async improveToolManually(toolName: string, newSource: string): Promise<boolean> {
    return await this.toolRegistry.updateTool(toolName, newSource);
  }

  getToolSource(toolName: string) {
    const tool = this.toolRegistry.tools[toolName];
    return tool ? tool.source : null;
  }

  get tools(): { [key: string]: Tool } {
    return this.toolRegistry.tools;
  }

  async pause(duration: number) {
    return await new Promise(resolve => setTimeout(resolve, duration));
  }

  private isRetryableError(error: any): boolean {
    const retryableErrorMessages = [
      'network timeout',
      'connection refused',
      'server unavailable',
    ];
    return retryableErrorMessages.some(message =>
      error.message.toLowerCase().includes(message)
    );
  }

  protected async retryOperation<T>(operation: () => Promise<T>, maxRetries: number, delay: number, toolName?: string): Promise<T> {
    let retries = 0;
    while (true) {
      try {
        this.globalRetryCount++;
        if (this.globalRetryCount > this.globalRetryLimit) {
          throw new Error("Global retry limit exceeded.");
        }
        await this.pause(1000);
        return await operation();
      } catch (error: any) {
        if (retries >= maxRetries || !this.isRetryableError(error)) {
          throw error;
        }

        retries++;
        const retryDelay = delay * Math.pow(2, retries);
        const message = toolName ? `Error calling tool '${toolName}': ${error.message}` : `Error: ${error.message}`;
        this.logWarn(`${message}. Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  async callTool(toolName: string, params: any) {
    this.logDebug(`Calling tool: ${toolName}`);
    if (Array.isArray(params)) params = params[0];

    return this.retryOperation(async () => {
      try {
        const tool = await this.toolRegistry.loadTool(toolName);
        if (!tool) {
          throw new Error(`Tool '${toolName}' not found.`);
        }

        return await this.toolRegistry.callTool(toolName, params);

      } catch (error: any) {
        if (toolName === 'ask' && error.message.includes('No response received')) {
          return "I'm sorry, but I didn't receive a response. Could you please try again?";
        } else if (toolName === 'busybox' && error.message.includes('No such file or directory')) {
          const alternativeLocation = await this.promptUser("The specified file or directory was not found. Please provide an alternative location:");
          if (alternativeLocation) {
            params.args[0] = alternativeLocation;
            return await this.callTool(toolName, params);
          }
        }
        throw error;
      }
    }, 3, 1000, toolName);
  }

  async showToolHistory(args: string[]) {
    if (args.length < 1) {
      this.logInfo("Usage: .tool history <name>");
      return;
    }

    const [name] = args;

    try {
      const history = await this.toolRegistry.getToolHistory(name);
      this.logInfo(name);
      history.forEach((entry: any) => {
        this.logInfo(`  ${entry}`);
      });
    } catch (error) {
      this.logError(`Error fetching tool history: ${error.message}`);
    }
  }

  async loadTool(name: string): Promise<Tool | undefined> {
    return await this.toolRegistry.loadTool(name);
  }

  async updateTool(name: string, source: string): Promise<boolean> {
    return await this.toolRegistry.updateTool(name, source);
  }

  async rollbackTool(name: string, version: string): Promise<boolean> {
    return await this.toolRegistry.rollbackTool(name, version);
  }

  private selectBestMemory(memories: Array<Memory & { similarity: number }>): Memory & { similarity: number } {
    return memories.reduce((best, current) =>
      (current.confidence * current.similarity > best.confidence * best.similarity) ? current : best
    );
  }

  private async adaptMemoryToInput(memory: Memory & { similarity: number }, newInput: string, model: string): Promise<string> {
    const convo = new Conversation(model);
    const prompt = `Given a new input and a similar previous experience, please adapt the previous response to fit the new input:

Previous Input: ${memory.input}
Previous Response: ${memory.response}
Tools Used: ${memory.usedTools.join(', ')}
New Input: ${newInput}

Adapted Response:`;

    const response = await convo.chat([
      { role: 'system', content: 'You are an AI assistant tasked with adapting previous responses to new inputs.' },
      { role: 'user', content: prompt }
    ]);

    return response.content[0].text;
  }

  async executeRegistryManagement(params: any): Promise<any> {
    return this.toolRegistry.tools['registry_management'].execute(this, params);
  }

  async callAgent(input: string, model = 'claude', resultVar?: string): Promise<{ success: boolean; data?: any; error?: Error; }> {
    const CONFIDENCE_THRESHOLD = 0.8;
    const SIMILARITY_THRESHOLD = 0.9;

    try {
      // Preprocessing step: Select relevant tools and retrieve similar memories
      const relevantTools = await this.toolRegistry.predictLikelyTools(input);
      const similarMemories = await this.memoryStore.findSimilarMemories(input, SIMILARITY_THRESHOLD);

      // Check if we can use an existing memory
      if (similarMemories.length > 0) {
        const adjustedMemories = similarMemories.map(memory => ({
          ...memory,
          adjustedConfidence: this.confidenceCalculator.calculateRetrievalConfidence(memory.confidence, memory.similarity)
        }));
        const bestMemory = this.selectBestMemory(adjustedMemories as any);

        if (bestMemory.adjustedConfidence > CONFIDENCE_THRESHOLD) {
          const adaptedResponse = await this.adaptMemoryToInput(bestMemory, input, model);
          await this.updateMemoryConfidence(bestMemory);
          return { success: true, data: adaptedResponse };
        }
      }

      // Prepare the prompt with the selected tools and similar memories
      const toolsRepresentation = this.toolRegistry.getCompactRepresentation(relevantTools);
      const memoriesRepresentation = this.prepareMemoriesRepresentation(similarMemories as any);

      const jsonPrompt = (compactRepresentation, memoriesRepresentation) => `Transform the given task into a sequence of subtasks, each with a JavaScript script that uses the provided tools to achieve the subtask objective.
  
  Available Tools:
  
  ${compactRepresentation}
  
  Similar Past Experiences:
  
  ${memoriesRepresentation}
  
  Additional tools can be explored using 'list_all_tools', 'get_tool_details', and 'load_tool'.
  
  Process:
  
  1. Analyze the task and identify necessary steps, considering similar past experiences
  2. Decompose into subtasks with clear objectives and input/output
  3. For each subtask, write a JavaScript script using the tools
    a. Access previous subtask results with taskResults.<taskName>_results: \`const lastResult = taskResults.firstTask_results; ...\`
    b. Store subtask results in a variable for future use: \`const result = { key: 'value' }; taskResults.subtask_results = result; ...\`
    b. End the script with a return statement for the subtask deliverable: \`return result;\`
  4. Test each script and verify the output
  5. Provide a concise explanation of the subtask's purpose and approach

  MAKE SURE THE SCRIPT YOU WRITE IS JAVSCRIPT.
  
  Data Management:
  
  - Store subtask results in resultVar (JSON/array format): \`taskResults.subtask_results = result;\`
  Access previous subtask data with taskResults.<resultVar>: \`const lastResult = taskResults.subtask_results; ...\`
  Include only resultVar instructions in responses, not the actual data.
  
  Output Format:
  \`\`\`json
  [
    {
    "task": "<taskName>:<description>",
    "script": "<JavaScript script>",
    "chat": "<subtask explanation>",
    "resultVar": "<optional result variable>"
    },
    // ... additional subtasks
  ]
  \`\`\`

  Examples:

\`\`\`json
[
  {
    "task": "get_last_100_lines:Get the last 100 lines of each log file in the /var/log directory",
    "script": "const files = await bash('ls /var/log');\nconst lastLines = await tools.callLLMs({ prompts: files.split('\\n'), system_prompt: 'Write a shell script that prints the last 100 lines of the given file: \${file}', resultVar: 'last100Lines' });\ntaskResults.last100Lines_results = last100Lines;\nreturn last100Lines;",
    "chat": "This subtask first lists all files in the \`/var/log\` directory. Then, it uses the \`callLLMs\` tool to generate a shell script for each file, which will extract the last 100 lines of that file. The results are stored in the \`last100Lines\` variable.",
    "resultVar": "last100Lines" 
  },
  {
    "task": "extract_errors:Extract timestamps and error messages from the retrieved log lines",
    "script": "const errors = [];\nfor (const line of taskResults.last100Lines_results) {\n  if (line.includes('ERROR')) {\n    const timestampRegex = /\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}/;\n    const timestampMatch = line.match(timestampRegex);\n    const timestamp = timestampMatch ? timestampMatch[1] : 'N/A';\n    const errorMessage = line.split('ERROR')[1].trim();\n    errors.push({ timestamp, message: errorMessage });\n  }\n}\ntaskResults.errors_results = errors;\nreturn errors;",
    "chat": "This subtask iterates through the \`last100Lines\` results and extracts timestamps and error messages for lines containing 'ERROR'. The extracted information is stored in the \`errors\` variable.",
    "resultVar": "errors"
  },
  {
    "task": "save_error_report:Save the extracted errors as a JSON file",
    "script": "await bash('echo \\\"' + JSON.stringify(taskResults.errors_results) + '\\\" > error_report.json');\nreturn 'Error report saved to error_report.json';",
    "chat": "This subtask writes the extracted errors (from the \`errors\` variable) to a JSON file named \`error_report.json\`."
  },
  {
    "task": "create_project_structure:Create the directory structure for the project",
    "script": "await bash('mkdir my-node-project');\ntaskResults.projectPath_results = 'my-node-project';\nreturn 'Project directory created';", 
    "chat": "Creates the main project directory (\`my-node-project\`)",
    "resultVar": "projectPath"
  },
  {
    "task": "create_config_file:Create and populate the config.json file",
    "script": "const config = { welcomeMessage: 'Hello from the new Node.js project!' };\nawait bash('echo \\\"' + JSON.stringify(config, null, 2) + '\\\" > \\\"' + taskResults.projectPath_results + '/config.json\\\"');\nreturn 'Configuration file created';", 
    "chat": "Creates \`config.json\` within the project directory and adds a default welcome message."
  },
  {
    "task": "generate_utils_module:Create the utils.js module with a logging function",
    "script": "const utilsCode = \`const logMessage = (message) => { console.log(message); };\nmodule.exports = { logMessage };\n\`;\nawait bash('echo \\\"' + utilsCode + '\\\" > \\\"' + taskResults.projectPath_results + '/utils.js\\\"');\nreturn 'Utility module created';", 
    "chat": "Creates \`utils.js\` with a function to log messages to the console." 
  },
  {
    "task": "generate_index_file:Create the main index.js file with logic to load configuration and use the utils module",
    "script": "const indexCode = \`const config = require('./config.json');\nconst { logMessage } = require('./utils');\nlogMessage(config.welcomeMessage);\n\`;\nawait bash('echo \\\"' + indexCode + '\\\" > \\\"' + taskResults.projectPath_results + '/index.js\\\"');\nreturn 'Index file created';", 
    "chat": "Creates \`index.js\`, which loads configuration and uses the \`logMessage\` function from \`utils.js\`."
  }
]
\`\`\`


CRITICAL: Verify the JSON output for accuracy and completeness before submission. *** OUTPUT ONLY JSON ***`;

      const convo = new Conversation(model);
      const response = await convo.chat([
        {
          role: 'system',
          content: jsonPrompt(toolsRepresentation, memoriesRepresentation)
        },
        {
          role: 'user',
          content: this.escapeTemplateLiteral(JSON.stringify({
            task: input,
          })),
        },
      ]);

      let tasks = response.content[0].text;
      tasks = tasks.replace(/```json/g, '').replace(/```/g, '');
      tasks = tasks.replace(/\n/g, '');


      let message = '';
      try {
        tasks = this.extractJson(tasks);
      } catch (error: any) {
        message = error.message;
      }
      if (!Array.isArray(tasks) || tasks.length === 0) {
        this.logError(message);
        throw new Error('The task must be an array of subtasks. Check the format and try again. RETURN ONLY JSON RESPONSES' + message);
      }

      const results: any = [];
      const usedTools: Set<string> = new Set();

      this.store[input] = tasks;

      if (Array.isArray(tasks) && Array.isArray(tasks[0])) {
        tasks = tasks[0];
      }

      if (resultVar) {
        this.store[resultVar] = results;
      }

      for (const task of tasks) {
        let { task: taskName, script, chat } = task;
        const splitTask = taskName.split(':');
        let taskId = taskName;
        if (splitTask.length > 1) {
          taskId = splitTask[0];
          taskName = splitTask[1];
        }
        this.store['currentTaskId'] = taskId;
        this.emit('taskId', taskId);

        this.store[`${taskId}_task`] = task;
        this.emit(`${taskId}_task`, task);

        this.store[`${taskId}_chat`] = chat;
        this.emit(`${taskId}_chat`, chat);

        this.store[`${taskId}_script`] = script;
        this.emit(`${taskId}_script`, script);

        const sr = await this.callScript(script);
        task.scriptResult = sr;

        // Track used tools
        const toolsUsedInScript = this.extractUsedTools(script);
        toolsUsedInScript.forEach(tool => usedTools.add(tool));

        this.store[`${taskId}_result`] = sr;
        this.store[`${taskId}_results`] = sr;
        const rout = { id: taskId, task: taskName, script, result: sr };
        this.emit(`${taskId}_results`, rout);

        results.push(rout as any);
      }

      const newMemory = JSON.stringify(tasks);

      // Store the new memory with used tools
      const initialConfidence = this.confidenceCalculator.calculateInitialConfidence(1.0, newMemory);
      await this.memoryStore.storeMemory(input, newMemory, initialConfidence);

      // Update confidence for similar memories
      for (const memory of similarMemories) {
        await this.updateMemoryConfidence(memory as any);
      }

      if (resultVar) {
        this.store[resultVar] = results;
      }

      // After processing all tasks, consider optimizing scripts
      this.optimizeScripts(tasks);

      return { success: true, data: results };
    } catch (error: any) {
      return { success: false, error: error };
    }
  }

  private prepareMemoriesRepresentation(memories: Array<Memory & { similarity: number }>): string {
    return memories.map(memory => `
Input: ${memory.input}
Response: ${memory.response}
Tools Used: ${memory.usedTools.join(', ')}
Confidence: ${memory.confidence}
Similarity: ${memory.similarity}
`).join('\n');
  }

  private extractUsedTools(script: string): string[] {
    const toolRegex = /tools\.(\w+)/g;
    const matches = script.match(toolRegex);
    return matches ? [...new Set(matches.map(match => match.split('.')[1]))] : [];
  }

  private async updateMemoryConfidence(memory: Memory & { similarity: number }) {
    const newConfidence = this.confidenceCalculator.updateConfidence(memory.confidence, memory.similarity);
    await this.memoryStore.updateMemory(memory.input, memory.response, newConfidence);
  }

  async callScript(script: string, retryLimit: number = 10): Promise<any> {
    let retryCount = 0;

    while (retryCount < retryLimit) {
      try {

          const existingTool = await this.toolRegistry.getTool(script);
          if (existingTool) {
            return await this.toolRegistry.callTool(existingTool.name, {});
          } else {
            this.considerAddingAsTool(script);
          }
    
          // If not, execute the script as before
          const context = this.prepareContext();
          const result = await this.executeScript(script, context);
          return result;

        } catch (error: any) {
          this.logError(`Error calling script: ${error}`);

          retryCount++;

          if (retryCount >= retryLimit) {
            this.errorLogger.logError({
              error: error.message,
              stackTrace: error.stack,
              script: script,
              retryAttempts: retryCount
            });
            throw new Error(`Script execution failed after ${retryLimit} attempts.`);
          }

          const errorMessage = error.message;
          const stackTrace: any = error.stack;
          const errorLine = this.extractErrorLine(stackTrace);

          let errDescription = `Error calling script (attempt ${retryCount}/${retryLimit}): ${errorMessage}\nScript: ${script}\nError Line: ${errorLine}\nStack Trace: ${stackTrace}\n\nAvailable Tools: ${Object.keys(this.toolRegistry.tools).join(', ')}\n\nIn context: ${Object.keys(this.prepareContext()).join(', ')}`;
          if(retryCount === retryLimit/2) { 
            errDescription += `\n\n*** Halfway through the retry limit. Try something else. ***`;
          }

          this.errorLogger.logError(errDescription);

          try {
            let llmResponse = await this.conversation.chat([{
              role: 'system',
              content: 'Analyze the provided script, script error, and context, generate a fixed version of the script, and output it and an explanation of your work in a JSON object. Output the modified script and explanation in JSON format { modifiedScript, explanation }. ***OUTPUT RAW JSON ONLY***.',
            },
            {
              role: 'user',
              content: errDescription,
            }]);

            if (typeof llmResponse === 'string') {
              llmResponse = JSON.parse(llmResponse);
            }

            const { modifiedScript, explanation } = JSON.parse(llmResponse.content[0].text);

            this.logInfo(explanation);

            script = this.unescapeTemplateLiteral(modifiedScript);

          } catch (fixError) {
            this.logError(`Error attempting to fix the script: ${fixError}`);
          }

          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        }
      }

      throw new Error("Reached end of callScript function. This should not happen.");
    }
  // async callScript(script: string, retryLimit: number = 10): Promise<any> {
  //   let retryCount = 0;
  
  //   while (retryCount < retryLimit) {
  //     try {
  //       // Check if this script already exists as a tool
  //       const existingTool = await this.toolRegistry.getTool(script);
  //       if (existingTool) {
  //         return await this.toolRegistry.callTool(existingTool.name, {});
  //       }
  
  //       // If not, execute the script as before
  //       const context = this.prepareContext();
  //       console.log('Executing script with context keys:', Object.keys(context));
  //       console.log('Tools available:', Object.keys(context.tools));
  //       console.log('Script to execute:', script);
  
  //       const result = await this.executeScript(script, context);
  
  //       // After successful execution, consider adding this script as a new tool
  //       this.considerAddingAsTool(script);
  
  //       return result;
  //     } catch (error) {
  //       console.error(`Error calling script (attempt ${retryCount + 1}/${retryLimit}):`, error);
  //       console.error('Script:', script);
  
  //       retryCount++;
  
  //       if (retryCount >= retryLimit) {
  //         throw new Error(`Script execution failed after ${retryLimit} attempts. Last error: ${error.message}`);
  //       }
  
  //       // Wait before retrying
  //       await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
  //     }
  //   }
  // }

  private prepareContext(): any {
    const context: any = {
      tools: {},
      taskResults: {},
      console: { log: console.log, error: console.error },
      require: require,
      fs: require('fs'),
      path: require('path'),
      axios: require('axios'),
      _: require('lodash'),
    };
  
    // Add tools from the ToolRegistry
    for (const toolName in this.toolRegistry.tools) {
      const toolFunction = async (...args: any[]) => {
        return await this.toolRegistry.callTool(toolName, args);
      };
      context.tools[toolName] = toolFunction;
      context[toolName] = toolFunction;
    }
  
    // Add tools from the imported tools.ts
    for (const [toolName, tool] of Object.entries(importedTools)) {
      const toolFunction = async (...args: any[]) => {
        return await tool.execute(...args, this);
      };
      context.tools[toolName] = toolFunction;
      context[toolName] = toolFunction;
    }
  
    // Add task results to the context
    for (const task in this.store) {
      context.taskResults[task] = this.store[task];
      context[task] = this.store[task];
    }
  
    return context;
  }


  private async executeScript(script: string, context: any): Promise<any> {


    // const vm = new VM({
    //   timeout: 5000,
    //   sandbox: context,
    // });
  
    const wrappedScript = `
      return (async (context) => {
        with (context) {
          return (async function() { ${script} })();
        }
      })(context);
    `;

    // we use a function to avoid polluting the global scope
    const scriptFunction = new Function('context', wrappedScript);
    const result = await scriptFunction(context);
    return result;
  }


  private async considerAddingAsTool(script: string): Promise<void> {
    // This method would analyze the script and potentially add it as a new tool
    // You can implement the logic based on your specific requirements
    await this.toolRegistry.analyzeAndCreateToolFromScript(script, "Auto-generated from successful script execution");
  }

  private async optimizeScripts(tasks: any[]): Promise<void> {
    for (const task of tasks) {
      await this.toolRegistry.improveTools();
    }
  }

  getSchemas() {
    return this.toolRegistry.schemas;
  }

  private extractErrorLine(stackTrace: string) {
    const lineRegex = /at .*? \(.*?:(\d+):\d+\)/;
    const match = stackTrace.match(lineRegex);
    return match && match[1] ? parseInt(match[1], 10) : null;
  }

  async promptUser(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.logInfo(question);
      this.chatWindow = (response: string) => {
        resolve(response);
      };
    });
  }

  extractJson(content: string) {
    return extractJson(content);
  }

  private escapeTemplateLiteral(str: string): string {
    return str;
  }

  private unescapeTemplateLiteral(str: string): string {
    return str.replace(/\\`/g, '`').replace(/\\\$\{/g, '${');
  }
}

export function extractJson(content: string): any[] {
  const jsonObjects: any[] = [];
  let depth = 0;
  let currentJson = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (escapeNext) {
      currentJson += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      currentJson += char;
      escapeNext = true;
      continue;
    }

    if (char === '"' && !inString) {
      inString = true;
      currentJson += char;
      continue;
    }

    if (char === '"' && inString) {
      inString = false;
      currentJson += char;
      continue;
    }

    if (!inString) {
      if (char === '{' || char === '[') {
        if (depth === 0) {
          currentJson = '';
        }
        depth++;
      } else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) {
          currentJson += char;
          try {
            const parsed = JSON.parse(currentJson);
            jsonObjects.push(parsed);
          } catch (error) {
            // If parsing fails, we don't attempt to fix it
            // as it might be intentionally escaped JSON within a string
          }
          currentJson = '';
          continue;
        }
      }
    }

    currentJson += char;
  }

  return jsonObjects;
}