import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import Conversation from './conversation';
import { Assistant } from './types';
import { ScriptValidator } from './script/validator';
import { ScriptPerformanceMonitor } from './script/performanceMonitor';
import { ScriptCleanupManager } from './script/cleanupManager';
import { MetadataManager, ScriptMetadata } from './script/metadataManager';

interface RegistryData {
  tools: Tool[];
}

export class Tool extends EventEmitter {
  public name: string;
  public description: string
  public version: string;
  public source: string;
  public tags: string[];
  public schema: any;
  public active: boolean;
  public testHarness: string;
  public _path: string;
  public lastTestResult: {
    success: boolean;
    message: string;
  } | null;
  public metrics: {
    versions: string[];
    totalUpdates: number;
    lastUpdated: string;
    testResults: {
      totalRuns: number;
      passed: number;
      failed: number;
      lastRun: string | null;
    };
    executionStats: {
      totalExecutions: number;
      averageExecutionTime: number;
      lastExecutionTime: number | null;
      fastestExecutionTime: number;
      slowestExecutionTime: number;
    };
    errorRate: number;
    usageCount: number;
  };
  public metadata: ScriptMetadata;

  constructor(
    private registry: ToolRegistry,
    name: string,
    version: string,
    description: string,
    source: string,
    tags: string[],
    schema: any,
    metadata?: ScriptMetadata
  ) {
    
    super();
    this.name = name;
    this.version = version;
    this.description = description;
    this.source = source;
    this.tags = tags;
    this.schema = schema;
    this.testHarness = '';
    this.lastTestResult = null;
    this.initializeMetrics();
    this._path = path.join(__dirname, `../../tool_repo/${this.name}`);
    this.metadata = metadata || {
      originalQuery: '',
      creationDate: new Date(),
      lastModifiedDate: new Date(),
      author: 'Unknown',
      version: '1.0.0',
      tags: [],
      dependencies: []
    };
  }

  private initializeMetrics(): void {
    this.metrics = {
      versions: [this.version],
      totalUpdates: 0,
      lastUpdated: new Date().toISOString(),
      testResults: {
        totalRuns: 0,
        passed: 0,
        failed: 0,
        lastRun: null,
      },
      executionStats: {
        totalExecutions: 0,
        averageExecutionTime: 0,
        lastExecutionTime: null,
        fastestExecutionTime: Infinity,
        slowestExecutionTime: 0,
      },
      errorRate: 0,
      usageCount: 0,
    };
  }

  executor(): (params: any, api: Assistant) => Promise<any> {
    return async (params: any, api: Assistant) => {
      const toolModule = await import(this.source);
      return await toolModule.default.execute(params, api);
    };
  }

  public saveMetrics(): void {
    this.registry.updateMetrics(this.name, 'version', this.version);
  }

  public async generateTestHarness(): Promise<void> {
    try {
      const messages = [
        {
          role: 'system',
          content: `You are a test coverage generator for javascript functions. Given a javascript function and its schema and description, you generate a test harness which thoroughly tests the function. You write your test harnesses in the following format:
\`\`\`javascript
const testHarness = {
    beforeAll: (context) => {
        context.log('beforeAll');
    },
    test1: (context) => {
        context.log('test1');
        context.assert(true, 'Test 1 passed');
    },
    test2: (context) => {
        context.log('test2');
    },
};
\`\`\`

You output RAW Javascript CODE ONLY. Do not include any comments or explanations in the code.`,
        },
        {
          role: 'user',
          content: `Tool Source:\n\n${JSON.stringify(this.source)}\n\nSchema:\n\n${JSON.stringify(this.schema)}\n\n`,
        },
      ];
      const response = await this.registry.conversation.chat(messages);
      this.testHarness = response.content[0].text;
      this.saveTool();
      this.emit('info', `Test harness generated for tool ${this.name}`);
    } catch (error) {
      this.emit('error', `Error generating test harness for tool ${this.name}:`, error);
    }
  }

  public async hardenToolCode(): Promise<void> {
    try {
      const messages = [
        {
          role: 'system',
          content: `You are a tool hardener. You take the given Javascript and you harden it if you see any security or execution vulnerabilities. You harden code by:
        - removing any awaiters and other intermediate-output code
        - adding any missing import statements
        - fixing any broken code. 
        - You output only RAW JAVASCRIPT, WITHOUT ANY COMMENTARY, EXPLANATION or FORMATTING.`,
        },
        {
          role: 'user',
          content: this.source,
        },
      ];
      const response = await this.registry.conversation.chat(messages);
      this.source = response.content[0].text;
      this.saveTool();
      this.emit('info', `Tool ${this.name} hardened successfully.`);
    } catch (error) {
      this.emit('error', `Error hardening tool ${this.name}:`, error);
    }
  }

  public async enhanceToolCode(): Promise<void> {
    try {
      const messages = [
        {
          role: 'system',
          content: `You are a tool enhancer. You take the given Javascript and you enhance it by:
        - enhancing options and settings
        - adding functionality which will make the tool more useful
        - adding more logging and error handling
        - You output only RAW JAVASCRIPT, WITH COMMENTARY, EXPLANATION and FORMATTING.`,
        },
        {
          role: 'user',
          content: this.source,
        },
      ];
      const response = await this.registry.conversation.chat(messages);
      this.source = response.content[0].text;
      this.saveTool();
      this.emit('info', `Tool ${this.name} enhanced successfully.`);
    } catch (error) {
      this.emit('error', `Error enhancing tool ${this.name}:`, error);
    }
  }

  public async prepareFunction(): Promise<string> {
    try {
      const messages = [
        {
          role: 'system',
          content: `You prepare javascript code for execution. You take the given Javascript and you:
        - fix any broken code
        - remove any awaiters and other intermediate-output code
        - add any missing import statements
        - Do NOT export the function, just return it as a string
        - You output only RAW JAVASCRIPT, WITH COMMENTARY, EXPLANATION and FORMATTING.`,
        },
        {
          role: 'user',
          content: this.source,
        },
      ];
      const response = await this.registry.conversation.chat(messages);
      return response.content[0].text;
    } catch (error) {
      this.emit('error', `Error preparing function for tool ${this.name}:`, error);
      throw error;
    }
  }

  public async runTests(): Promise<void> {
    if (!this.testHarness) {
      this.emit('error', `No test harness found for tool ${this.name}`);
      return;
    }
    try {
      const context = {
        log: (message: string) => this.emit('info', `[${this.name} Test] ${message}`),
        assert: (condition: boolean, message: string) => {
          this.emit('info', `[${this.name} Test] ${message}`);
          if (!condition) {
            throw new Error(message);
          }
        },
      };
      const testHarness = new Function('context', `return ${this.testHarness}`)();
      await testHarness.beforeAll(context);
      for (const key in testHarness) {
        if (key !== 'beforeAll') {
          await testHarness[key](context);
        }
      }

      this.lastTestResult = {
        success: true,
        message: 'All tests passed successfully',
      };

      this.saveTool();
      this.updateMetrics('test', { success: true });
    } catch (error) {
      this.emit('error', `Error running tests for tool ${this.name}:`, error);
      this.lastTestResult = {
        success: false,
        message: `Test failed: ${error.message}`,
      };
      this.updateMetrics('test', { success: false });
    }
  }

  public async saveTool(): Promise<void> {
    try {
      const toolIndex = this.registry.registryData.tools.findIndex(t => t.name === this.name);
      if (toolIndex === -1) {
        this.emit('error', `Tool not found: ${this.name}`);
        return;
      }
      this.registry.registryData.tools[toolIndex] = this;
      this.registry.saveRegistry();
      this.emit('info', `Tool ${this.name} saved successfully.`);
    } catch (error) {
      this.emit('error', `Error saving tool ${this.name}:`, error);
    }
  }

  public async call(params: any, parent: any): Promise<any> {
    try {
      this.updateMetrics('usage', null);
      const startTime = Date.now();
      const result = await this.executor()(params, parent);
      const endTime = Date.now();
      this.updateMetrics('execution', endTime - startTime);
      return result;
    } catch (error) {
      this.updateMetrics('error', true);
      this.emit('error', `Error executing tool ${this.name}:`, error);
      throw error;
    }
  }

  public updateMetrics(updateType: 'version' | 'test' | 'execution' | 'error' | 'usage', data: any): void {
    switch (updateType) {
      case 'version':
        this.metrics.versions.push(data);
        this.metrics.totalUpdates++;
        this.metrics.lastUpdated = new Date().toISOString();
        break;
      case 'test':
        this.metrics.testResults.totalRuns++;
        if (data.success) {
          this.metrics.testResults.passed++;
        } else {
          this.metrics.testResults.failed++;
        }
        this.metrics.testResults.lastRun = new Date().toISOString();
        break;
      case 'execution':
        const executionTime = data;
        this.metrics.executionStats.totalExecutions++;
        this.metrics.executionStats.averageExecutionTime =
          (this.metrics.executionStats.averageExecutionTime * (this.metrics.executionStats.totalExecutions - 1) + executionTime) /
          this.metrics.executionStats.totalExecutions;
        this.metrics.executionStats.lastExecutionTime = executionTime;
        this.metrics.executionStats.fastestExecutionTime = Math.min(this.metrics.executionStats.fastestExecutionTime, executionTime);
        this.metrics.executionStats.slowestExecutionTime = Math.max(this.metrics.executionStats.slowestExecutionTime, executionTime);
        break;
      case 'error':
        this.metrics.errorRate = (this.metrics.errorRate * this.metrics.usageCount + (data ? 1 : 0)) / (this.metrics.usageCount + 1);
        break;
      case 'usage':
        this.metrics.usageCount++;
        break;
    }
    this.saveMetrics();
  }
}

class ToolRegistry extends EventEmitter {
  public registryData: RegistryData;
  private registryFile: string;
  private loadedTools: Set<string>;
  private repoPath: string;
  private metricsFile: string;
  private metrics: { [key: string]: any };
  private testInterval: NodeJS.Timeout;
  public conversation: Conversation;

  constructor(registryFile: string = './.registry', repoPath: string = '../../tool_repo', metricsFile: string = './.metrics') {
    super();
    const registryFileP = path.join(__dirname, repoPath, registryFile);

    if (!fs.existsSync(registryFileP)) {
      fs.mkdirSync(path.dirname(registryFileP), { recursive: true });
      fs.writeFileSync(registryFileP, JSON.stringify({ tools: [] }), 'utf8');
    }

    this.registryFile = path.join(__dirname, repoPath, registryFile);
    this.repoPath = path.join(__dirname, repoPath);
    this.metricsFile = path.join(__dirname, repoPath, metricsFile);

    this.loadedTools = new Set();
    this.registryData = { tools: [] };
    this.conversation = new Conversation('claude');
    this.metrics = {};
    this.initializeRegistry();
    this.startContinuousTesting();
  }

  async addScriptAsTool(name: string, source: string, originalQuery: string): Promise<boolean> {
    const isValid = await ScriptValidator.validate(source);
    if (!isValid) {
      console.error(`Script ${name} failed validation`);
      return false;
    }

    const success = await this.addTool(name, source, {}, ['ai-generated']);
    if (success) {
      await MetadataManager.addMetadata(this, name, {
        originalQuery,
        creationDate: new Date(),
        author: 'AI Assistant',
        version: '1.0.0',
        tags: ['ai-generated'],
        dependencies: []
      });
    }
    return success;
  }

  async executeTool(name: string, params: any): Promise<any> {
    const startTime = Date.now();
    const result = await this.call(name, params);
    const executionTime = Date.now() - startTime;
    ScriptPerformanceMonitor.recordExecution(name, executionTime);
    return result;
  }

  async call(name: string, params: any): Promise<any> {
    const tool = this.registryData.tools.find(t => t.name === name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return await tool.call(params, this as any);
  }

  async performMaintenance(): Promise<void> {
    await ScriptCleanupManager.cleanupUnusedScripts(this);
    // Other maintenance tasks...
  }

  private startContinuousTesting() {
    this.testInterval = setInterval(() => {
      this.testAndImproveTools();
    }, 3600000); // Run every hour
  }

  private async testAndImproveTools() {
    for (const tool of this.registryData.tools) {
      const testResult = await this.testTool(tool);
      if (!testResult.success) {
        await this.improveTool(tool);
      }
    }
  }

  private async testTool(tool: Tool): Promise<{ success: boolean; error?: string }> {
    if (!tool.testHarness) {
      await tool.generateTestHarness();
    }
    try {
      await tool.runTests();
      return { success: tool.lastTestResult?.success || false, error: tool.lastTestResult?.message };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async improveTools(): Promise<void> {
    for (const tool of this.registryData.tools) {
      if (tool.lastTestResult && !tool.lastTestResult.success) {
        await this.improveTool(tool);
      }
    }
  }

  private async improveTool(tool: Tool): Promise<void> {
    try {
      const improvedCode = await this.conversation.chat([{
        role: 'system',
        content:
          'You are javascript developer working to improve javascript functions. Given the function\'s source code, schema, and any existing test results, <important>output an improved version of the function. If you cannot improve the function, output the original source code.</important><critical>output NO commentary, explanation or formatting</critical>',
      }, {
        role: 'user',
        content: `Tool Source: ${tool.source}\nSchema: ${JSON.stringify(tool.schema)}\nTest Results: ${JSON.stringify(tool.lastTestResult)}`,
      }], {} as any, 'gemini-1.5-flash-001');
      await this.updateTool(tool.name, improvedCode, tool.schema, tool.tags);
      this.emit('text', `Tool ${tool.name} improved based on test results`);
    } catch (error) {
      this.emit('error', `Error improving tool ${tool.name}:`, error);
    }
  }

  async updateMetrics(toolName: string, updateType: 'version' | 'test' | 'execution' | 'error' | 'usage', data: any): Promise<void> {
    if (!this.metrics[toolName]) {
      this.metrics[toolName] = {
        versions: [],
        totalUpdates: 0,
        lastUpdated: null,
        testResults: {
          totalRuns: 0,
          passed: 0,
          failed: 0,
          lastRun: null,
        },
        executionStats: {
          totalExecutions: 0,
          averageExecutionTime: 0,
          lastExecutionTime: null,
          fastestExecutionTime: Infinity,
          slowestExecutionTime: 0,
        },
        errorRate: 0,
        usageCount: 0,
      };
    }

    const metrics = this.metrics[toolName];

    switch (updateType) {
      case 'version':
        metrics.versions.push(data);
        metrics.totalUpdates++;
        metrics.lastUpdated = new Date().toISOString();
        break;
      case 'test':
        metrics.testResults.totalRuns++;
        if (data.success) {
          metrics.testResults.passed++;
        } else {
          metrics.testResults.failed++;
        }
        metrics.testResults.lastRun = new Date().toISOString();
        break;
      case 'execution':
        const executionTime = data;
        metrics.executionStats.totalExecutions++;
        metrics.executionStats.averageExecutionTime =
          (metrics.executionStats.averageExecutionTime * (metrics.executionStats.totalExecutions - 1) + executionTime) /
          metrics.executionStats.totalExecutions;
        metrics.executionStats.lastExecutionTime = executionTime;
        metrics.executionStats.fastestExecutionTime = Math.min(metrics.executionStats.fastestExecutionTime, executionTime);
        metrics.executionStats.slowestExecutionTime = Math.max(metrics.executionStats.slowestExecutionTime, executionTime);
        break;
      case 'error':
        metrics.errorRate = (metrics.errorRate * metrics.usageCount + (data ? 1 : 0)) / (metrics.usageCount + 1);
        break;
      case 'usage':
        metrics.usageCount++;
        break;
    }

    this.saveMetrics();
  }

  async generateReport(format: 'text' | 'json' = 'text'): Promise<string | object> {
    if (format === 'json') {
      return this.metrics;
    }

    let report = "Tool Registry Report\n=====================\n\n";

    for (const [toolName, toolMetrics] of Object.entries(this.metrics)) {
      report += `Tool: ${toolName}\n`;
      report += `------------------\n`;
      report += `Current Version: ${toolMetrics.versions[toolMetrics.versions.length - 1]}\n`;
      report += `Total Updates: ${toolMetrics.totalUpdates}\n`;
      report += `Last Updated: ${toolMetrics.lastUpdated}\n`;
      report += `Test Results:\n`;
      report += `  Total Runs: ${toolMetrics.testResults.totalRuns}\n`;
      report += `  Passed: ${toolMetrics.testResults.passed}\n`;
      report += `  Failed: ${toolMetrics.testResults.failed}\n`;
      report += `  Last Run: ${toolMetrics.testResults.lastRun}\n`;
      report += `Execution Stats:\n`;
      report += `  Total Executions: ${toolMetrics.executionStats.totalExecutions}\n`;
      report += `  Average Execution Time: ${toolMetrics.executionStats.averageExecutionTime.toFixed(2)}ms\n`;
      report += `  Fastest Execution Time: ${toolMetrics.executionStats.fastestExecutionTime.toFixed(2)}ms\n`;
      report += `  Slowest Execution Time: ${toolMetrics.executionStats.slowestExecutionTime.toFixed(2)}ms\n`;
      report += `  Last Execution Time: ${toolMetrics.executionStats.lastExecutionTime?.toFixed(2)}ms\n`;
      report += `Error Rate: ${(toolMetrics.errorRate * 100).toFixed(2)}%\n`;
      report += `Usage Count: ${toolMetrics.usageCount}\n\n`;
    }

    return report;
  }

  get tools(): { [key: string]: Tool } {
    return this.registryData.tools.reduce((tools, tool) => {
      tools[tool.name] = tool;
      return tools;
    }, {} as { [key: string]: Tool });
  }

  get schemas(): any {
    return this.registryData.tools.reduce((schemas, tool) => {
      schemas[tool.name] = tool.schema;
      return schemas;
    }, {} as any);
  }

  private async initializeRegistry(): Promise<void> {
    try {
      if (!fs.existsSync(this.registryFile)) {
        await this.importToolsFromFile();
      } else {
        console.log('Loading registry from file...');
        this.loadRegistry();
      }
    } catch (error) {
      console.error('Error initializing registry:', error);
      this.registryData = { tools: [] };
    }
  }

  async getToolHistory(name: string): Promise<string[]> {
    const tool = this.registryData.tools.find(t => t.name === name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return this.metrics[name]?.versions || [];
  }

  private loadRegistry(): void {
    try {
      if (fs.existsSync(this.registryFile)) {
        const data = fs.readFileSync(this.registryFile, 'utf8');
        this.registryData = JSON.parse(data);
        console.log('Registry loaded successfully.');
      } else {
        this.registryData = { tools: [] };
        this.importToolsFromFile();
      }
    } catch (error) {
      console.error('Error loading registry:', error);
      this.registryData = { tools: [] };
    }
  }

  public saveRegistry(): void {
    try {
      const registryDataWithoutCircular = JSON.parse(JSON.stringify(this.registryData, (key, value) =>
        key === 'registry' || key === '_client' ? undefined : value
      ));
      const data = JSON.stringify(registryDataWithoutCircular, null, 2);
      fs.writeFileSync(this.registryFile, data, 'utf8');
      console.log('Registry saved successfully.');
    } catch (error) {
      console.error('Error saving registry:', error);
    }
  }

  private async importToolsFromFile(): Promise<void> {
    try {
      const toolsModule = await import('./tools');
      for (const [name, tool] of Object.entries(toolsModule.tools)) {
        await this.addTool(name, tool.execute.toString(), tool.schema || {}, tool.tags || []);
      }
      console.log('Tools imported from tools.ts file.');
    } catch (error) {
      console.error('Error importing tools from file:', error);
    }
  }

  public async getToolList(): Promise<Tool[]> {
    return this.registryData.tools;
  }

  public async createToolSchema(tool: string): Promise<any> {
    try {
      const messages = [{
        role: 'system',
        content: "Given the source code of a tool, you generate a schema for it. Example schema 1: { 'name': 'file', 'description': 'Performs file operations like read, write, append, prepend, replace, insert, remove, delete, copy', 'input_schema': { 'type': 'object', 'properties': { 'operation': { 'type': 'string', 'description': 'The operation to perform on the file. Supported operations: read, write, append, prepend, replace, insert_at, remove, delete, copy', 'enum': ['read', 'write', 'append', 'prepend', 'replace', 'insert_at', 'remove', 'delete', 'copy'], }, 'path': { 'type': 'string', 'description': 'The path to the file. Required for all operations except 'list_attached'.', }, 'match': { 'type': 'string', 'description': 'The string or regex pattern to match. Required for 'replace' and 'remove' operations.', }, 'data': { 'type': 'string', 'description': 'The data to write, append, prepend, replace, or insert. Required for 'write', 'append', 'prepend', 'replace', and 'insert_at' operations.', }, 'position': { 'type': 'number', 'description': 'The position to insert the data at. Required for 'insert_at' operation.', }, 'target': { 'type': 'string', 'description': 'The target path for the 'copy' operation.', }, }, 'required': ['operation'], }, 'output_schema': { 'type': 'string', 'description': 'A message indicating the result of the file operation.', }, }\n\nExample Schema 2: {'name': 'files', 'description': 'Performs batch file operations.', 'input_schema': {'type': 'object', 'properties': {'operations': {'type': 'array', 'description': 'An array of file operations to perform.', 'items': {'type': 'object', 'properties': {'operation': {'type': 'string', 'description': 'The operation to perform on the file.', 'enum': ['read', 'append', 'prepend', 'replace', 'insert_at', 'remove', 'delete', 'copy', 'attach', 'list_attached', 'detach']}, 'path': {'type': 'string', 'description': 'The path to the file. Required for all operations except 'list_attached'.', }, 'match': {'type': 'string', 'description': 'The string or regex pattern to match. Required for 'replace' and 'remove' operations.', }, 'data': {'type': 'string', 'description': 'The data to write, append, prepend, replace, or insert. Required for 'write', 'append', 'prepend', 'replace', and 'insert_at' operations.', }, 'position': {'type': 'number', 'description': 'The position to insert the data at. Required for 'insert_at' operation.', }, 'target': {'type': 'string', 'description': 'The target path for the 'copy' operation.', }, }, 'required': ['operation']}}}, 'required': ['operations']}, 'output_schema': {'type': 'string', 'description': 'A message indicating the result of the batch file operations.'}},",
      }, {
        role: 'user',
        content: 'Examine the source code of the tool and generate a schema for it: ' + JSON.stringify(tool)
      }];
      const response = await this.conversation.chat(messages);
      return JSON.parse(response.content[0].text);
    } catch (error) {
      console.error(`Error creating schema for tool ${tool}:`, error);
      throw error;
    }
  }

  public async cleanupToolCode(tool: string): Promise<string> {
    try {
      const messages = [{
        role: 'system',
        content: `You take the given Javascript and you:

1. fix any broken code, 
2. rewrite the function to remove awaiters and other intermediate-output code 
3. add any missing import statements - for example use \`const fs = await import('fs');\` for file system operations
4. Do NOT export the function, just return it as a string
5. FORMAT THE FUNCTION NICELY OVER MULTIPLE LINES

You output only RAW JAVASCRIPT, WITHOUT ANY COMMENTARY, EXPLANATION or FORMATTING`
      }, {
        role: 'user',
        content: tool
      }];
      let response = await this.conversation.chat(messages);
      response = response.content[0].text;
      response = response.replace(/.*```javascript/g, '');
      response = response.replace(/.*```/g, '');
      response = response.replace(/[\r\n]+/g, '');
      return response;
    } catch (error) {
      console.error(`Error cleaning up tool code for ${tool}:`, error);
      throw error;
    }
  }

  public async addToolSchema(tool: string, schema: any): Promise<boolean> {
    try {
      const toolIndex = this.registryData.tools.findIndex(t => t.name === tool);
      if (toolIndex === -1) {
        console.error(`Tool not found: ${tool}`);
        return false;
      }
      this.registryData.tools[toolIndex].schema = schema;
      this.saveRegistry();
      console.log(`Schema added for tool ${tool}`);
      return true;
    } catch (error) {
      console.error(`Error adding schema to tool ${tool}:`, error);
      return false;
    }
  }

  async loadTool(name: string): Promise<any | null> {
    try {
      if (this.loadedTools.has(name)) {
        console.log(`Tool ${name} already loaded.`);
        return null;
      }

      const tool = this.registryData.tools.find(t => t.name === name);
      if (!tool) {
        console.error(`Tool not found: ${name}`);
        return null;
      }

      const toolModule = await import(`${this.repoPath}/${name}.js`);
      this.loadedTools.add(name);
      console.log(`Tool ${name} loaded successfully.`);
      return toolModule.default;
    } catch (error) {
      console.error(`Error loading tool ${name}:`, error);
      return null;
    }
  }

  async updateTool(name: string, source: string, schema: any, tags: any): Promise<boolean> {
    try {
      const toolIndex = this.registryData.tools.findIndex(t => t.name === name);
      if (toolIndex === -1) {
        console.error(`Tool not found: ${name}`);
        return false;
      }

      const tool: Tool = this.registryData.tools[toolIndex];
      const newVersion = this.incrementVersion(tool.version);

      tool.version = newVersion;
      tool.tags = tags;
      tool.active = true;
      this.saveRegistry();

      if ((schema && schema !== tool.schema) || source) {
        source && (tool.source = source);
        schema && (tool.schema = schema);

        if (schema) {
          // Save schema to metadata
          const metadata: any = await MetadataManager.getMetadata(this, name);
          metadata.schema = schema;

          await MetadataManager.updateMetadata(this, name, metadata);
        }

        // re-run tests
        await tool.generateTestHarness();

        // Update metrics
        this.updateMetrics(name, 'version', newVersion);
      }

      await this.saveToolToRepo(name, source, newVersion);
      console.log(`Tool ${name} updated to version ${newVersion}.`);
      this.updateMetrics(name, 'version', newVersion);
      return true;
    } catch (error) {
      console.error(`Error updating tool ${name}:`, error);
      return false;
    }
  }

  validateToolInput(toolName: string, params: any): { valid: boolean; errors: any[] } {
    const tool = this.tools[toolName];
    if (!tool || !tool.schema) {
      return { valid: true, errors: [] };
    }
    // Implement input validation logic here
    return { valid: true, errors: [] };
  }

  private async saveToolToRepo(name: string, source: string, version: string): Promise<void> {
    try {
      const filePath = path.join(this.repoPath, `${name}.js`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source);
      console.log(`Tool ${name} v${version} saved to repository successfully.`);
    } catch (error) {
      console.error(`Error saving tool ${name} to repository:`, error);
    }
  }

  async callTool(name: string, params: any): Promise<any> {
    const tool = this.tools[name];
    if (!tool) throw new Error(`Tool not found: ${name}`);
  
    try {
      const startTime = Date.now();
      const toolModule = await import(tool._path);
      const result = await toolModule.default(params, this);
      const endTime = Date.now();
      const executionTime = endTime - startTime;
      this.updateMetrics(name, 'execution', executionTime);
    } catch (error) {
      console.error(`Error executing tool ${name}:`, error);
      throw error;
    }
  }

  // async callTool(name: string, params: any): Promise<any> {
  //   try {
  //     const tool = this.registryData.tools.find(t => t.name === name);
  //     if (!tool) {
  //       throw new Error(`Tool not found: ${name}`);
  //     }

  //     const startTime = Date.now();
  //     const toolModule = await import(tool.path);
  //     const result = await toolModule.default.execute(params, this);
  //     const endTime = Date.now();
  //     const executionTime = endTime - startTime;
  //     this.updateMetrics(name, 'execution', executionTime);
  //     return result;
  //   } catch (error) {
  //     console.error(`Error executing tool ${name}:`, error);
  //     throw error;
  //   }
  // }

  async getTool(scriptOrName: string): Promise<Tool | null> {
    // First, try to find the tool by name
    const tool = this.tools[scriptOrName];
    if (tool) return tool;
  
    // If not found by name, check if any tool's source matches the script
    for (const t of Object.values(this.tools)) {
      if (t.source === scriptOrName) return t;
    }
  
    return null;
  }

  async rollbackTool(name: string, version: string): Promise<boolean> {
    try {
      const toolIndex = this.registryData.tools.findIndex(t => t.name === name);
      if (toolIndex === -1) {
        this.emit('error', `Tool not found: ${name}`);
        return false;
      }

      const source = await this.getTool(name);
      if (!source) {
        this.emit('error', `Source code not found for tool ${name} version ${version}`);
        return false;
      }

      const tool = this.registryData.tools[toolIndex];
      tool.version = version;
      tool.source = tool.source
      tool.active = true;
      this.saveRegistry();

      this.emit('text', `Tool ${name} rolled back to version ${version} successfully.`);
      this.updateMetrics(name, 'version', version);
      return true;
    } catch (error) {
      this.emit('error', `Error rolling back tool ${name}:`, error);
      return false;
    }
  }

  private incrementVersion(version: string): string {
    const [major, minor, patch] = version.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }

  async getToolTags(name: string): Promise<string[]> {
    const tool = this.registryData.tools.find(t => t.name === name);
    return tool ? tool.tags || [] : [];
  }

  async initialize(): Promise<void> {
    await this.initializeRegistry();
    this.loadMetrics();
    for (const tool of this.registryData.tools) {
      await this.loadTool(tool.name);
    }
    await this.generateAndRunTests();
  }

  getCompactRepresentation(): any {
    // schema.methodSignature - description
    return this.registryData.tools.map(tool => `${tool.schema.methodSignature} - ${tool.schema.description}`).join('\n');
  }

  async createNewToolWithLLM(
    description: string,
    schema: any,
    constraints: string[]
  ): Promise<Tool | null> {
    try {
      let toolCode = await this.conversation.chat([{
        role: 'system',
        content: `You create Javascript functions given a set of instructions. 
You will be given a description, a schema, and a set of constraints. 
Generate the JavaScript code for a tool that fulfills the requirements while observing the constraints..
Return a JSON object with the following format: { "name": "function_name", "description": "Brief description", "methodSignature": "function_name(param1: type, param2: type): returnType", "source": "function function_name(param1, param2) { ... }" }
You output only RAW JAVASCRIPT, WITHOUT ANY COMMENTARY, EXPLANATION or FORMATTING`
      }, {
        role: 'user',
        content: `Description: ${description}\nSchema: ${JSON.stringify(
          schema
        )}\nConstraints: ${constraints.join(', ')}`
      }], {} as any, 'gemini-1.5-flash-001');
      toolCode = toolCode.content[0].text;
      const { name, methodSignature } = JSON.parse(toolCode);

      await this.addTool(name, toolCode, schema, []);

      const toolName = schema.name;
      const success = await this.addTool(
        toolName,
        toolCode,
        schema,
        []
      );
      if (success) {
        this.emit('text', `Tool ${toolName} created successfully.`);
        return this.tools[toolName];
      } else {
        this.emit('error', 'Failed to add the generated tool to the registry.');
        return null;
      }
    } catch (error) {
      this.emit('error', 'Error creating tool with LLM:', error);
      return null;
    }
  }

  async generateAndRunTests(): Promise<void> {
    for (const tool of this.registryData.tools) {
      // load a real Tool instance
      const ttool = new Tool(this, tool.name, tool.version, tool.description, tool.source, tool.tags, tool.schema);
      await ttool.generateTestHarness();
      try {
        await ttool.runTests();
      } catch (error) {
        this.emit('text', `Error running tests for tool ${tool.name}:`, error);
      }
    }
  }

  async analyzeAndCreateToolFromScript(script: string, taskDescription: string): Promise<void> {
    const existingTools = await this.getToolList();
    const existingToolNames = existingTools.map(tool => tool.name);

    const analysisPrompt = `
        Given the following script and task description, determine if this script represents a unique and reusable functionality not adequately covered by existing tools.
  
        Existing tools: ${existingToolNames.join(', ')}
  
        Script:
        ${script}
  
        Task Description:
        ${taskDescription}
  
        If this script represents a unique and reusable functionality, provide the following in JSON format:
        1. A semantically-meaningful function name
        2. A brief description of the tool's functionality
        3. A method signature
        4. Any necessary modifications to make the script more generalized and reusable
  
        If the functionality is already adequately represented by existing tools, return null.
  
        Response format:
        {
          "name": "function_name",
          "description": "Brief description",
          "methodSignature": "function_name(param1: type, param2: type): returnType",
          "modifiedScript": "// Modified script code"
        }
      `;

    let analysisResult = await this.conversation.chat([{
      role: 'system',
      content: 'You are an AI assistant tasked with analyzing scripts and creating reusable tools. You return RAW JSON ONLY without any commentary or explanation.',
    }, {
      role: 'user',
      content: analysisPrompt + '\n\nREMEMBER TO RETURN RAW JSON ONLY WITHOUT ANY COMMENTARY OR EXPLANATION.',

    }]);

    if (analysisResult) {
      analysisResult = analysisResult.content[0].text;
      // const { name, description, methodSignature, modifiedScript } = JSON.parse(analysisResult);
      // const schema = {
      //   name,
      //   description,
      //   methodSignature
      // };

      // await this.addAutoGeneratedTool(name, modifiedScript, schema);
    }
  }

  async addAutoGeneratedTool(name: string, source: string, schema: any): Promise<boolean> {
    const similarTool = this.registryData.tools.find(tool =>
      tool.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(tool.name.toLowerCase())
    );

    if (similarTool) {
      console.log(`Similar tool '${similarTool.name}' already exists. Skipping addition.`);
      return false;
    }

    return this.addTool(name, source, schema, ['auto-generated']);
  }

  async reviewAutoGeneratedTools(): Promise<void> {
    const autoGeneratedTools = this.registryData.tools.filter(tool => tool.tags.includes('auto-generated'));

    for (const tool of autoGeneratedTools) {
      const reviewPrompt = `
  Review the following auto-generated tool and determine if it should be kept, modified, or removed:
  
  Name: ${tool.name}
  Description: ${tool.schema.description}
  Method Signature: ${tool.schema.methodSignature}
  Source:
  ${tool.source}
  
  Provide your recommendation in JSON format:
  {
    "action": "keep" | "modify" | "remove",
    "reason": "Brief explanation",
    "modifications": "If action is 'modify', provide the modified source code here"
  }
  `;

      const reviewResult = await this.conversation.chat([{
        role: 'system',
        content: 'You are an AI assistant tasked with reviewing and maintaining the tool registry within which you operate.',
      }, {
        role: 'user',
        content: reviewPrompt
      }], {
        responseFormat: '{ "action": "string", "reason": "string", "modifications": "string" }[]'
      } as any);

      switch (reviewResult.action) {
        case 'keep':
          console.log(`Tool '${tool.name}' kept. Reason: ${reviewResult.reason}`);
          break;
        case 'modify':
          await this.updateTool(tool.name, reviewResult.modifications, tool.schema, tool.tags);
          console.log(`Tool '${tool.name}' modified. Reason: ${reviewResult.reason}`);
          break;
        case 'remove':
          await this.removeTool(tool.name);
          console.log(`Tool '${tool.name}' removed. Reason: ${reviewResult.reason}`);
          break;
      }
    }
  }

  async removeTool(name: string): Promise<boolean> {
    const initialLength = this.registryData.tools.length;
    this.registryData.tools = this.registryData.tools.filter(tool => tool.name !== name);
    const removed = this.registryData.tools.length < initialLength;
    if (removed) {
      this.saveRegistry();
      console.log(`Tool '${name}' removed successfully.`);
    }
    return removed;
  }

  async addTool(name: string, source: string, schema: any, tags: string[]): Promise<boolean> {
    try {
      if (this.registryData.tools.some(t => t.name === name)) {
        return false;
      }

      let standardizedSource = source;
      try {
        standardizedSource = await this.standardizeTool(name, source, schema);
      } catch (error) {
        console.warn(`Failed to standardize tool ${name}. Using original source.`, error);
      }

      const version = '1.0.0';
      const newTool = new Tool(this, name, version, schema.description, standardizedSource, tags, schema);

      this.registryData.tools.push(newTool);
      this.saveRegistry();

      await this.saveToolToRepo(name, standardizedSource, version);
      console.log(`Tool ${name} added successfully.`);
      return true;
    } catch (error) {
      console.error(`Error adding tool ${name}:`, error);
      return false;
    }
  }

  async performPeriodicMaintenance(): Promise<void> {
    await this.reviewAutoGeneratedTools();
    await this.improveTools();
    // Add any other maintenance tasks here
  }

  private loadMetrics(): void {
    try {
      if (fs.existsSync(this.metricsFile)) {
        const data = fs.readFileSync(this.metricsFile, 'utf8');
        this.metrics = JSON.parse(data);
        console.log('Metrics loaded successfully.');
      } else {
        this.metrics = {};
      }
    } catch (error) {
      console.error('Error loading metrics:', error);
      this.metrics = {};
    }
  }

  private saveMetrics(): void {
    try {
      const data = JSON.stringify(this.metrics, null, 2);
      fs.writeFileSync(this.metricsFile, data, 'utf8');
      console.log('Metrics saved successfully.');
    } catch (error) {
      console.error('Error saving metrics:', error);
    }
  }

  private initializeMetrics(toolName: string): void {
    if (!this.metrics[toolName]) {
      this.metrics[toolName] = {
        versions: [],
        totalUpdates: 0,
        lastUpdated: new Date().toISOString(),
        testResults: {
          totalRuns: 0,
          passed: 0,
          failed: 0,
          lastRun: null,
        },
        executionStats: {
          totalExecutions: 0,
          averageExecutionTime: 0,
          lastExecutionTime: null,
          fastestExecutionTime: Infinity,
          slowestExecutionTime: 0,
        },
        errorRate: 0,
        usageCount: 0,
      };
    }
  }

  async standardizeTool(name: string, source: string, schema: any): Promise<string> {
    const systemMessage = {
      role: 'system',
      content: `You are an AI assistant tasked with standardizing tool code into a specific module format. Use the template below, incorporating the given code into the execute function. Fix any obvious issues and ensure the code is properly formatted and exported.
Template:

// This is javascript code for a tool module
class ${name}Tool {

  async execute(params, api) {
    // Tool implementation goes here
  }

}

module.exports = new ${name}Tool();`
    };
    const userMessage = {
      role: 'user',
      content: `Original Tool Code:
${source}

Schema:
${JSON.stringify(schema, null, 2)}
  
Please provide the complete standardized tool module code, including the class definition and export.
<critical>DO NOT include any commentary, explanation, or formatting. YOUR OUTPUT SHOULD BE RAW Javascript Code</critical>`,
    }
    let response = await this.conversation.chat([systemMessage, userMessage]);
    return response.content[0].text;
  }

  async predictLikelyTools(userRequest: string): Promise<string[]> {
    const existingTools = await this.getToolList();
    const existingToolNames = existingTools.map(tool => tool.name);

    const prompt = `Given the following user request and list of existing tools, predict the most likely tools to be used and suggest new tools that need to be created to service the task.
  
User Request: ${userRequest}

Existing Tools: ${existingToolNames.join(', ')}

Provide your response in the following JSON format:
{
  "likelyTools": ["tool1", "tool2", ...],
  "newTools": ["newTool1", "newTool2", ...]
}
      `;

    const response = await this.conversation.chat([{
      role: 'system',
      content: 'You are an AI assistant tasked with predicting and suggesting tools for a given task.',
    }, {
      role: 'user',
      content: prompt
    }], {
      responseFormat: '{ "likelyTools": string[], "newTools": string[] }'
    } as any);

    return [...response.likelyTools, ...response.newTools];
  }
}

export default ToolRegistry;

export const toolRegistryTools = {
  list_tools: {
    name: 'list_tools',
    version: '1.1.0',
    description: 'List all tools in the registry, optionally filtered by tags',
    schema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to filter tools' }
      }
    },
    execute: async (params: { tags?: string[] }, api: ToolRegistry) => {
      const allTools = await api.getToolList();
      if (params.tags && params.tags.length > 0) {
        return allTools.filter(tool => params.tags!.every(tag => tool.tags.includes(tag)));
      }
      return allTools;
    }
  },

  add_tool: {
    name: 'add_tool',
    version: '1.2.0',
    description: 'Add a new tool to the registry',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool' },
        source: { type: 'string', description: 'Source code of the tool' },
        description: { type: 'string', description: 'Description of the tool' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the tool' },
        schema: { type: 'object', description: 'Schema for the tool' },
        originalQuery: { type: 'string', description: 'Original query that led to the creation of this tool' }
      },
      required: ['name', 'source', 'description']
    },
    execute: async (params: any, api: ToolRegistry) => {
      const isValid = await ScriptValidator.validate(params.source);
      if (!isValid) {
        throw new Error('Tool validation failed');
      }
      const success = await api.addTool(params.name, params.source, params.schema || {}, params.tags || []);
      if (success) {
        await MetadataManager.addMetadata(api, params.name, {
          originalQuery: params.originalQuery || '',
          creationDate: new Date(),
          author: 'User',
          version: '1.0.0',
          tags: params.tags || [],
          dependencies: []
        });
      }
      return success;
    }
  },

  update_tool: {
    name: 'update_tool',
    version: '1.1.0',
    description: 'Update an existing tool in the registry',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool to update' },
        source: { type: 'string', description: 'New source code of the tool' },
        description: { type: 'string', description: 'New description of the tool' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags for the tool' },
        schema: { type: 'object', description: 'New schema for the tool' }
      },
      required: ['name', 'source']
    },
    execute: async (params: any, api: ToolRegistry) => {
      const isValid = await ScriptValidator.validate(params.source);
      if (!isValid) {
        throw new Error('Tool validation failed');
      }
      return api.updateTool(params.name, params.source, params.schema, params.tags);
    }
  },

  delete_tool: {
    name: 'delete_tool',
    version: '1.0.0',
    description: 'Delete a tool from the registry',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool to delete' }
      },
      required: ['name']
    },
    execute: async (params: { name: string }, api: ToolRegistry) => {
      return api.removeTool(params.name);
    }
  },

  get_tool_metadata: {
    name: 'get_tool_metadata',
    version: '1.0.0',
    description: 'Get metadata for a specific tool',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool' }
      },
      required: ['name']
    },
    execute: async (params: { name: string }, api: ToolRegistry) => {
      return MetadataManager.getMetadata(api, params.name);
    }
  },

  update_tool_metadata: {
    name: 'update_tool_metadata',
    version: '1.0.0',
    description: 'Update metadata for a specific tool',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool' },
        metadata: { type: 'object', description: 'New metadata for the tool' }
      },
      required: ['name', 'metadata']
    },
    execute: async (params: { name: string, metadata: Partial<ScriptMetadata> }, api: ToolRegistry) => {
      await MetadataManager.addMetadata(api, params.name, params.metadata);
      return true;
    }
  },

  get_tool_performance: {
    name: 'get_tool_performance',
    version: '1.0.0',
    description: 'Get performance metrics for a specific tool',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool' }
      },
      required: ['name']
    },
    execute: async (params: { name: string }, api: ToolRegistry) => {
      return ScriptPerformanceMonitor.getMetrics(params.name);
    }
  },

  get_all_performance_metrics: {
    name: 'get_all_performance_metrics',
    version: '1.0.0',
    description: 'Get performance metrics for all tools',
    schema: {},
    execute: async (params: {}, api: ToolRegistry) => {
      return ScriptPerformanceMonitor.getAllMetrics();
    }
  },

  run_maintenance: {
    name: 'run_maintenance',
    version: '1.0.0',
    description: 'Run maintenance tasks on the tool registry',
    schema: {},
    execute: async (params: {}, api: ToolRegistry) => {
      await api.performMaintenance();
      return 'Maintenance tasks completed';
    }
  },

  analyze_and_create_tool: {
    name: 'analyze_and_create_tool',
    version: '1.1.0',
    description: 'Analyze a script and create a new tool if it represents unique functionality',
    schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The script to analyze' },
        taskDescription: { type: 'string', description: 'Description of the task the script performs' }
      },
      required: ['script', 'taskDescription']
    },
    execute: async (params: { script: string, taskDescription: string }, api: ToolRegistry) => {
      await api.analyzeAndCreateToolFromScript(params.script, params.taskDescription);
      return 'Analysis and tool creation completed';
    }
  },

  predict_likely_tools: {
    name: 'predict_likely_tools',
    version: '1.0.0',
    description: 'Predict likely tools to be used for a given task',
    schema: {
      type: 'object',
      properties: {
        userRequest: { type: 'string', description: 'The user request to analyze' }
      },
      required: ['userRequest']
    },
    execute: async (params: { userRequest: string }, api: ToolRegistry) => {
      return api.predictLikelyTools(params.userRequest);
    }
  },

  get_tool_history: {
    name: 'get_tool_history',
    version: '1.0.0',
    description: 'Get the version history of a specific tool',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool' }
      },
      required: ['name']
    },
    execute: async (params: { name: string }, api: ToolRegistry) => {
      return api.getToolHistory(params.name);
    }
  },

  rollback_tool: {
    name: 'rollback_tool',
    version: '1.0.0',
    description: 'Rollback a tool to a previous version',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool' },
        version: { type: 'string', description: 'Version to rollback to' }
      },
      required: ['name', 'version']
    },
    execute: async (params: { name: string, version: string }, api: ToolRegistry) => {
      return api.rollbackTool(params.name, params.version);
    }
  },

  generate_tool_report: {
    name: 'generate_tool_report',
    version: '1.0.0',
    description: 'Generate a comprehensive report about the tool registry',
    schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['text', 'json'], description: 'Output format of the report' }
      }
    },
    execute: async (params: { format?: 'text' | 'json' }, api: ToolRegistry) => {
      return api.generateReport(params.format || 'text');
    }
  }
};
