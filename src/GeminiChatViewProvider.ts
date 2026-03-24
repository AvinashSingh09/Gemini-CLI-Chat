import * as vscode from 'vscode';
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';

class GeminiIdeServer {
    private _server: http.Server | null = null;
    private _port: number = 0;
    private _authToken: string = Math.random().toString(36).substring(2);
    private _discoveryFilePath: string | null = null;

    constructor(
        private readonly _provider: GeminiChatViewProvider,
        private readonly _workspacePath: string
    ) {}

    public async start(): Promise<void> {
        if (this._server) return;

        this._server = http.createServer((req, res) => {
            const authHeader = req.headers['authorization'];
            if (authHeader !== `Bearer ${this._authToken}`) {
                res.writeHead(401);
                res.end('Unauthorized');
                return;
            }

            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const json = JSON.parse(body || '{}');
                    this.handleMcpRequest(json, res);
                } catch (e) {
                    res.writeHead(400);
                    res.end('Bad Request');
                }
            });
        });

        return new Promise<void>((resolve, reject) => {
            this._server?.listen(0, '127.0.0.1', () => {
                const address = this._server?.address() as any;
                this._port = address.port;
                this.writeDiscoveryFile().then(resolve).catch(reject);
            });
        });
    }

    private async writeDiscoveryFile() {
        const ideDir = path.join(os.tmpdir(), 'gemini', 'ide');
        if (!fs.existsSync(ideDir)) {
            fs.mkdirSync(ideDir, { recursive: true });
        }

        const pid = process.pid;
        const filename = `gemini-ide-server-${pid}-${this._port}.json`;
        this._discoveryFilePath = path.join(ideDir, filename);

        const data = {
            port: this._port,
            workspacePath: this._workspacePath,
            authToken: this._authToken,
            ideInfo: {
                name: 'vscode',
                displayName: 'VS Code'
            }
        };

        fs.writeFileSync(this._discoveryFilePath, JSON.stringify(data, null, 2));
    }

    private handleMcpRequest(data: any, res: http.ServerResponse) {
        const { method, params, id } = data;
        
        switch (method) {
            case 'tools/list':
                res.end(JSON.stringify({
                    id,
                    result: {
                        tools: [
                            {
                                name: 'openDiff',
                                description: 'Open a diff view for a specific file to propose changes.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        filePath: { type: 'string' },
                                        newContent: { type: 'string' }
                                    },
                                    required: ['filePath', 'newContent']
                                }
                            }
                        ]
                    }
                }));
                break;
            case 'tools/call':
                if (params.name === 'openDiff') {
                    const { filePath, newContent } = params.arguments;
                    this._provider.handleOpenDiff(filePath, newContent);
                    res.end(JSON.stringify({ id, result: { content: [] } }));
                } else {
                    res.end(JSON.stringify({ id, error: { message: 'Tool not found' } }));
                }
                break;
            default:
                res.end(JSON.stringify({ id, error: { message: 'Method not found' } }));
        }
    }

    public stop() {
        this._server?.close();
        this._server = null;
        if (this._discoveryFilePath && fs.existsSync(this._discoveryFilePath)) {
            try { fs.unlinkSync(this._discoveryFilePath); } catch(e) {}
        }
    }

    public get port() { return this._port; }
}

export class GeminiChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'geminiChatView';
    private _view?: vscode.WebviewView;
    private _ideServer: GeminiIdeServer | null = null;
    private _activeSessionId: string | null = null;
    private _yoloEnabled: boolean = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
    ) { 
        this._yoloEnabled = this._context.workspaceState.get<boolean>('geminiYoloEnabled', false);
    }

    public async handleOpenDiff(filePath: string, newContent: string) {
        if (this._view) {
            this._view.webview.postMessage({ 
                type: 'fileAction', 
                file: path.basename(filePath),
                path: filePath,
                action: 'edit'
            });
        }
        const uri = vscode.Uri.file(filePath);
        const tempUri = vscode.Uri.parse(`untitled:${filePath}.propose`);
        
        // Use a temporary file to show the diff
        const edit = new vscode.WorkspaceEdit();
        edit.insert(tempUri, new vscode.Position(0, 0), newContent);
        await vscode.workspace.applyEdit(edit);

        await vscode.commands.executeCommand('vscode.diff', uri, tempUri, `Proposed Changes: ${path.basename(filePath)}`);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Load existing history
        const sessions = this._context.workspaceState.get<any>('geminiChatSessions', {});
        this._activeSessionId = this._context.workspaceState.get<string>('geminiActiveSessionId') || null;
        
        if (this._activeSessionId && sessions[this._activeSessionId]) {
            webviewView.webview.postMessage({ type: 'loadHistory', value: sessions[this._activeSessionId].messages });
        }

        // Send initial state
        webviewView.webview.postMessage({ type: 'yoloState', value: this._yoloEnabled });

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'sendPrompt':
                    await this.askGemini(data.value, data.model, data.images || [], data.imagePreviews || []);
                    break;
                case 'login':
                    this.handleLogin();
                    break;
                case 'getAuthState':
                    this.sendAuthState();
                    break;
                case 'toggleYolo':
                    this._yoloEnabled = data.value;
                    this._context.workspaceState.update('geminiYoloEnabled', this._yoloEnabled);
                    break;
                case 'clearHistory':
                    this._context.workspaceState.update('geminiChatSessions', {});
                    this._context.workspaceState.update('geminiActiveSessionId', null);
                    this._activeSessionId = null;
                    break;
                case 'newChat':
                    this._activeSessionId = Date.now().toString();
                    this._context.workspaceState.update('geminiActiveSessionId', this._activeSessionId);
                    break;
                case 'getSessions':
                    const allSess = this._context.workspaceState.get<any>('geminiChatSessions', {});
                    webviewView.webview.postMessage({ type: 'sessionsList', value: allSess });
                    break;
                case 'loadSession':
                    const sessionsMap = this._context.workspaceState.get<any>('geminiChatSessions', {});
                    if (sessionsMap[data.sessionId]) {
                        this._activeSessionId = data.sessionId;
                        this._context.workspaceState.update('geminiActiveSessionId', this._activeSessionId);
                        webviewView.webview.postMessage({ type: 'loadHistory', value: sessionsMap[data.sessionId].messages });
                    }
                    break;
                case 'deleteSession':
                    const currentSessions = this._context.workspaceState.get<any>('geminiChatSessions', {});
                    if (currentSessions && currentSessions[data.sessionId]) {
                        delete currentSessions[data.sessionId];
                        this._context.workspaceState.update('geminiChatSessions', currentSessions);
                        // If we deleted the active session, clear it
                        if (this._activeSessionId === data.sessionId) {
                            this._activeSessionId = null;
                            this._context.workspaceState.update('geminiActiveSessionId', null);
                        }
                    }
                    break;
                case 'openFile':
                    const uri = vscode.Uri.file(data.value);
                    vscode.workspace.openTextDocument(uri).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                    break;
                case 'pickImage':
                    {
                        const imageUris = await vscode.window.showOpenDialog({
                            canSelectMany: true,
                            filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] },
                            title: 'Select images to attach'
                        });
                        if (imageUris && imageUris.length > 0 && this._view) {
                            const images = imageUris.map(u => {
                                try {
                                    const data = fs.readFileSync(u.fsPath);
                                    const ext = path.extname(u.fsPath).substring(1).toLowerCase();
                                    const mime = ext === 'svg' ? 'svg+xml' : ext;
                                    return {
                                        path: u.fsPath,
                                        name: path.basename(u.fsPath),
                                        preview: `data:image/${mime};base64,${data.toString('base64')}`
                                    };
                                } catch {
                                    return { path: u.fsPath, name: path.basename(u.fsPath), preview: null };
                                }
                            });
                            this._view.webview.postMessage({ type: 'imagesSelected', images });
                        }
                        break;
                    }
                case 'pasteImage':
                    {
                        try {
                            const b64 = data.data.replace(/^data:image\/\w+;base64,/, '');
                            const ext = (data.data.match(/^data:image\/(\w+)/)?.[1] || 'png');
                            const tmpDir = path.join(os.tmpdir(), 'gemini-chat-images');
                            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                            const filename = `paste-${Date.now()}.${ext}`;
                            const filePath = path.join(tmpDir, filename);
                            fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
                            if (this._view) {
                                this._view.webview.postMessage({
                                    type: 'imagesSelected',
                                    images: [{ path: filePath, name: filename, preview: data.data }]
                                });
                            }
                        } catch (e) {
                            console.error('Paste image error:', e);
                        }
                        break;
                    }
                case 'getWorkspaceFiles':
                    await this.sendWorkspaceFiles(data.query || '');
                    break;
            }
        });
    }

    private handleLogin() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: 'Opening a new terminal for secure interactive authentication. Please check the bottom panel!' });
        }
        const term = vscode.window.createTerminal("Gemini Auth");
        term.show();
        term.sendText('gemini -i "/auth signin"');
    }

    private sendAuthState() {
        if (!this._view) return;
        try {
            const accountsPath = path.join(os.homedir(), '.gemini', 'google_accounts.json');
            if (fs.existsSync(accountsPath)) {
                const data = fs.readFileSync(accountsPath, 'utf8');
                const parsed = JSON.parse(data);
                if (parsed.active) {
                    this._view.webview.postMessage({ type: 'authState', email: parsed.active });
                    return;
                }
            }
        } catch (err) {}
        this._view.webview.postMessage({ type: 'authState', email: null });
    }

    private async sendWorkspaceFiles(query: string) {
        if (!this._view) return;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            this._view.webview.postMessage({ type: 'workspaceFiles', files: [] });
            return;
        }
        try {
            const pattern = query ? `**/*${query}*` : '**/*';
            const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/.gemini/**}';
            const uris = await vscode.workspace.findFiles(pattern, excludePattern, 30);
            const rootPath = workspaceFolders[0].uri.fsPath;
            const files = uris.map(u => ({
                name: path.basename(u.fsPath),
                relativePath: path.relative(rootPath, u.fsPath).replace(/\\/g, '/'),
                fullPath: u.fsPath
            }));
            this._view.webview.postMessage({ type: 'workspaceFiles', files });
        } catch (e) {
            this._view.webview.postMessage({ type: 'workspaceFiles', files: [] });
        }
    }

    private async askGemini(prompt: string, model: string = "auto", images: string[] = [], imagePreviews: any[] = []) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt, images: imagePreviews });
            this._view.webview.postMessage({ type: 'setLoading', value: true });
        }

        let cwdPath: string | undefined;
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            cwdPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            
            if (!this._ideServer && cwdPath) {
                this._ideServer = new GeminiIdeServer(this, cwdPath);
                await this._ideServer.start().catch(e => console.error("IDE Server start fail:", e));
            }

            const geminiDir = path.join(cwdPath, '.gemini');
            const settingsFile = path.join(geminiDir, 'settings.json');
            if (!fs.existsSync(settingsFile)) {
                try {
                    if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });
                    const setup = { mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", cwdPath] } } };
                    fs.writeFileSync(settingsFile, JSON.stringify(setup, null, 2));
                } catch (e) {}
            }
        }

        const isWindows = process.platform === 'win32';
        const command = isWindows ? 'gemini.cmd' : 'gemini';

        const spawnOptions: any = { 
            shell: true,
            env: { 
                ...process.env, 
                "FORCE_COLOR": "1",
                "GEMINI_CLI_IDE_WORKSPACE_PATH": cwdPath || "",
                "GEMINI_CLI_IDE_SERVER_PORT": this._ideServer?.port?.toString() || ""
            }
        };
        if (cwdPath) spawnOptions.cwd = cwdPath;

        let enrichedPrompt = prompt;
        const visibleEditors = vscode.window.visibleTextEditors;
        if (visibleEditors.length > 0) {
            let context = "CONTEXT: The user currently has the following files open in the editor: ";
            for (const editor of visibleEditors) {
                context += `[${editor.document.uri.fsPath}] `;
            }
            enrichedPrompt = context + "--- USER REQUEST: " + prompt;
        }

        // Prepend image file references so the CLI reads them as context
        if (images && images.length > 0) {
            const imageRefs = images.map(img => `@${img}`).join(' ');
            enrichedPrompt = imageRefs + ' ' + enrichedPrompt;
        }

        enrichedPrompt = enrichedPrompt.replace(/\r?\n/g, ' ');
        const safePrompt = enrichedPrompt.replace(/"/g, '\\"');
        const args = ['-p', `"${safePrompt}"`];

        if (model && model !== 'auto') {
            args.push('-m');
            args.push(model);
        }
        if (this._yoloEnabled) args.push('-y');

        if (!this._activeSessionId) {
            this._activeSessionId = Date.now().toString();
            this._context.workspaceState.update('geminiActiveSessionId', this._activeSessionId);
        }

        const sessions = this._context.workspaceState.get<any>('geminiChatSessions', {});
        if (!sessions[this._activeSessionId]) {
            sessions[this._activeSessionId] = {
                id: this._activeSessionId,
                title: prompt.substring(0, 30) + (prompt.length > 30 ? '...' : ''),
                timestamp: Date.now(),
                messages: []
            };
            this._context.workspaceState.update('geminiChatSessions', sessions);
        }

        // Capture state BEFORE CLI runs (for file change detection)
        let preGitNumstat = '';
        let preMtimes = new Map<string, number>();
        if (cwdPath) {
            try {
                preGitNumstat = execSync('git diff --numstat', { cwd: cwdPath, encoding: 'utf8', timeout: 5000 }).trim();
            } catch {
                // If not a git repo, fallback to collecting mtimes
                preMtimes = this.getFileMtimes(cwdPath);
            }
        }

        const child = spawn(command, args, spawnOptions);
        const thinkingStartTime = Date.now();

        child.on('error', (err) => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', value: false });
                this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `Failed: ${err.message}` });
            }
        });

        let output = '';
        let thinkingOutput = '';
        let isFirstStdout = true;

        // stderr = CLI thinking/debug output (YOLO, MCP, extensions, etc.)
        const stderrNoisePatterns = [
            /YOLO mode/i, /Loaded cached credentials/i, /\[ERROR\] \[IDEClient\]/i,
            /Please ensure the extension is running/i, /To install the extension/i,
            /Loading extension:/i, /Scheduling MCP context/i, /Executing MCP context/i,
            /MCP context refresh/i, /\[MCP info\]/i, /Registering notification/i,
            /Capabilities:\s*\{/i, /Server '.*' supports/i, /Listening for changes/i,
            /supabase undefined/i, /already in progress/i, /tools:\s*\{/i,
            /listChanged:/i,
        ];

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            thinkingOutput += chunk;

            // Filter out noisy boot lines for display
            const lines = chunk.split('\n');
            const meaningfulLines = lines.filter((line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return false;
                return !stderrNoisePatterns.some(p => p.test(trimmed));
            });

            if (meaningfulLines.length > 0 && this._view) {
                this._view.webview.postMessage({ type: 'streamThinking', content: meaningfulLines.join('\n') + '\n' });
            }
        });

        // stdout = actual Gemini response
        let isThinkingPhase = true;
        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;

            if (this._view) {
                if (isFirstStdout) {
                    this._view.webview.postMessage({ type: 'setLoading', value: false });
                    isFirstStdout = false;
                }

                const { reasoning, response } = this.splitReasoningFromResponse(output);

                if (isThinkingPhase && response.trim().length > 0) {
                    isThinkingPhase = false;
                    const thinkingElapsed = Math.round((Date.now() - thinkingStartTime) / 1000);
                    this._view.webview.postMessage({ type: 'thinkingDone', seconds: thinkingElapsed, content: thinkingOutput });
                }

                if (isThinkingPhase) {
                    this._view.webview.postMessage({ type: 'streamReasoning', reasoning });
                } else {
                    this._view.webview.postMessage({ type: 'streamMessageDynamic', response });
                }
            }
        });

        child.on('close', (code) => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', value: false });

                // If we never got stdout, finalize thinking and show error
                if (isFirstStdout && thinkingOutput.length > 0) {
                    const thinkingElapsed = Math.round((Date.now() - thinkingStartTime) / 1000);
                    this._view.webview.postMessage({ type: 'thinkingDone', seconds: thinkingElapsed, content: thinkingOutput });
                }

                if (code !== 0 && output.length === 0) {
                    this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `Error (Code ${code}):\n${thinkingOutput}` });
                } else if (code !== 0) {
                    this._view.webview.postMessage({ type: 'streamMessage', content: `\n\n[Exited with code ${code}]` });
                }

                let finalReasoning = '';
                let finalResponse = output || thinkingOutput;

                // Post-process locally to ensure exact division before saving
                if (output.length > 0) {
                    const { reasoning, response } = this.splitReasoningFromResponse(output);
                    if (reasoning.length > 0) {
                        finalReasoning = reasoning;
                        finalResponse = response || output;
                    }
                }

                const allSessions = this._context.workspaceState.get<any>('geminiChatSessions', {});
                if (this._activeSessionId && allSessions[this._activeSessionId]) {
                    allSessions[this._activeSessionId].messages.push({ role: 'user', content: prompt });
                    allSessions[this._activeSessionId].messages.push({ role: 'assistant', content: finalResponse, reasoning: finalReasoning });
                    this._context.workspaceState.update('geminiChatSessions', allSessions);
                }

                // Detect file changes (Git preferred, fallback to mtime)
                if (cwdPath) {
                    let changedFiles: any[] = [];
                    try {
                        const postGitNumstat = execSync('git diff --numstat', { cwd: cwdPath, encoding: 'utf8', timeout: 5000 }).trim();
                        changedFiles = this.detectFileChanges(preGitNumstat, postGitNumstat, cwdPath);
                    } catch {
                        // Git failed (not a repo), use the mtime fallback
                        const postMtimes = this.getFileMtimes(cwdPath);
                        postMtimes.forEach((mtime, file) => {
                            const preMtime = preMtimes.get(file);
                            // If it's a new file or has a newer modified time
                            if (!preMtime || mtime > preMtime) {
                                const ext = path.extname(file).substring(1).toLowerCase();
                                changedFiles.push({
                                    file: path.relative(cwdPath, file).replace(/\\/g, '/'),
                                    name: path.basename(file),
                                    fullPath: file,
                                    ext: ext,
                                    insertions: undefined,
                                    deletions: undefined
                                });
                            }
                        });
                        // Fast deletion check
                        preMtimes.forEach((mtime, file) => {
                            if (!postMtimes.has(file)) {
                                const ext = path.extname(file).substring(1).toLowerCase();
                                changedFiles.push({
                                    file: path.relative(cwdPath, file).replace(/\\/g, '/'),
                                    name: path.basename(file),
                                    fullPath: file,
                                    ext: ext,
                                    insertions: 0,
                                    deletions: 1
                                });
                            }
                        });
                    }

                    if (changedFiles.length > 0 && this._view) {
                        this._view.webview.postMessage({ type: 'fileChanges', files: changedFiles });
                    }
                }
            }
        });
    }

    private getFileMtimes(dir: string, mtimes: Map<string, number> = new Map()): Map<string, number> {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                // Ignore extremely heavy or irrelevant directories
                if (file === 'node_modules' || file === '.git' || file === 'out' || file === 'dist' || file === '.next' || file === '.gemini') continue;
                
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                
                if (stat.isDirectory()) {
                    this.getFileMtimes(fullPath, mtimes);
                } else {
                    mtimes.set(fullPath, stat.mtimeMs);
                }
            }
        } catch {}
        return mtimes;
    }

    private detectFileChanges(pre: string, post: string, cwdPath: string): any[] {
        const parseNumstat = (text: string) => {
            const map = new Map<string, { add: number; del: number }>();
            text.split('\n').filter(l => l.trim()).forEach(line => {
                const parts = line.split('\t');
                if (parts.length >= 3) {
                    map.set(parts[2], { add: parseInt(parts[0]) || 0, del: parseInt(parts[1]) || 0 });
                }
            });
            return map;
        };

        const preMap = parseNumstat(pre);
        const postMap = parseNumstat(post);
        const changes: any[] = [];

        postMap.forEach((stats, file) => {
            const preStat = preMap.get(file);
            if (!preStat || preStat.add !== stats.add || preStat.del !== stats.del) {
                const ext = path.extname(file).substring(1).toLowerCase();
                changes.push({
                    file: file,
                    name: path.basename(file),
                    fullPath: path.join(cwdPath, file),
                    ext: ext,
                    insertions: stats.add,
                    deletions: stats.del
                });
            }
        });

        return changes;
    }

    private splitReasoningFromResponse(text: string): { reasoning: string; response: string } {
        const reasoningPatterns = [
            /^I will /i, /^I'll /i, /^I'm /i, /^I need to /i,
            /^I should /i, /^Let me /i, /^I can /i, /^I've /i,
            /^I encountered /i, /^I have identified/i, /^I have found/i,
            /^Now,? I/i, /^Next,? I/i, /^First,? I/i, /^Then,? I/i,
            /^Finally,? I/i, /^I also /i, /^I want to /i,
            /^Scheduling /i, /^Executing /i, /^Loading /i,
            /^Registering /i, /^Capabilities:/i, /^Server '/i,
        ];

        // Split on sentence boundaries: period followed by space + capital letter, or by "I " patterns
        const sentences = text.split(/(?<=\.)\s+(?=[A-Z])/);
        
        let reasoningParts: string[] = [];
        let responseParts: string[] = [];
        let foundResponse = false;

        for (const sentence of sentences) {
            const trimmed = sentence.trim();
            if (!trimmed) continue;

            if (!foundResponse) {
                const isReasoning = reasoningPatterns.some(p => p.test(trimmed));
                if (isReasoning) {
                    reasoningParts.push(trimmed);
                } else {
                    // This is the start of the actual response
                    foundResponse = true;
                    responseParts.push(trimmed);
                }
            } else {
                responseParts.push(trimmed);
            }
        }

        if (reasoningParts.length > 0) {
            return {
                reasoning: reasoningParts.join(' '),
                response: responseParts.join(' ')
            };
        }

        return { reasoning: '', response: text };
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'style.css'));
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Chat</title>
    <link href="${cssUri}" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
</head>
<body>
    <div id="app-header">
        <div class="header-left">
            <svg class="gemini-logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z" fill="url(#paint0_linear)"/><defs><linearGradient id="paint0_linear" x1="2" y1="12" x2="22" y2="12" gradientUnits="userSpaceOnUse"><stop stop-color="#4E82EE"/><stop offset="1" stop-color="#B06AB3"/></linearGradient></defs></svg>
            <span class="title">GEMINI CHAT</span>
        </div>
        <div class="header-actions">
            <button id="yolo-btn" class="icon-btn" title="Autonomous Mode (YOLO)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            </button>
            <button id="new-chat-btn-header" class="icon-btn" title="New Chat">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
            <button id="history-btn" class="icon-btn" title="History">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            </button>
            <button id="toggle-settings-btn" class="icon-btn" title="Settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
        </div>
    </div>
    <div id="history-view" class="view hidden">
        <div class="view-header"><h3>Recent Chats</h3><button id="close-history-btn" class="icon-btn">✕</button></div>
        <div id="history-list"></div>
    </div>
    <div id="chat-view" class="view">
        <div id="messages"></div>
        <div id="bottom-anchor">
            <div id="loading" class="hidden">Gemini is thinking...</div>
            <div id="mention-dropdown" class="hidden"></div>
            <div id="input-wrapper">
                <div id="attachment-previews" class="hidden"></div>
                <textarea id="prompt-input" placeholder="Ask anything, @ to mention, / for workflows" rows="1"></textarea>
                <div id="action-row">
                    <div class="action-left">
                        <div class="add-context-wrapper">
                            <button id="add-context-btn" class="icon-btn ctx-btn" title="Add context">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                            </button>
                            <div id="context-menu" class="hidden">
                                <div class="context-menu-header">Add context</div>
                                <div class="context-menu-item" id="ctx-media">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                                    Media
                                </div>
                                <div class="context-menu-item" id="ctx-mentions">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg>
                                    Mentions
                                </div>
                            </div>
                        </div>
                        <select id="model-select" class="model-selector">
                            <option value="auto">Auto (Gemini 3)</option>
                            <option value="gemini-3-pro-preview">gemini-3-pro-preview</option>
                            <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                            <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                            <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                        </select>
                    </div>
                    <div class="action-right">
                        <button id="send-button" title="Send">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div id="settings-view" class="view hidden">
        <h2>Settings</h2>
        <div id="auth-info-text"></div>
        <button id="login-btn">Login</button>
        <button id="clear-btn">Clear History</button>
    </div>
    <script src="${jsUri}"></script>
</body>
</html>`;
    }
}
