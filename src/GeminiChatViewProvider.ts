import * as vscode from 'vscode';
import { spawn } from 'child_process';
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
                    await this.askGemini(data.value, data.model);
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
                case 'openFile':
                    const uri = vscode.Uri.file(data.value);
                    vscode.workspace.openTextDocument(uri).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
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

    private async askGemini(prompt: string, model: string = "auto") {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt });
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

        const child = spawn(command, args, spawnOptions);

        child.on('error', (err) => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', value: false });
                this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `Failed: ${err.message}` });
            }
        });

        let output = '';
        let errorOutput = '';
        let isFirstOutput = true;

        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;
            if (this._view) {
                if (isFirstOutput) {
                    this._view.webview.postMessage({ type: 'setLoading', value: false });
                    isFirstOutput = false;
                }
                this._view.webview.postMessage({ type: 'streamMessage', content: chunk });
            }
        });

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            errorOutput += chunk;
            if (this._view && isFirstOutput) {
                this._view.webview.postMessage({ type: 'setLoading', value: false });
                isFirstOutput = false;
            }
            if (this._view) {
                this._view.webview.postMessage({ type: 'streamMessage', content: chunk });
            }
        });

        child.on('close', (code) => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', value: false });
                if (code !== 0 && output.length === 0) {
                    this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `Error (Code ${code}):\n${errorOutput}` });
                } else if (code !== 0) {
                    this._view.webview.postMessage({ type: 'streamMessage', content: `\n\n[Exited with code ${code}]` });
                }

                const allSessions = this._context.workspaceState.get<any>('geminiChatSessions', {});
                if (this._activeSessionId && allSessions[this._activeSessionId]) {
                    allSessions[this._activeSessionId].messages.push({ role: 'user', content: prompt });
                    allSessions[this._activeSessionId].messages.push({ role: 'assistant', content: output || errorOutput });
                    this._context.workspaceState.update('geminiChatSessions', allSessions);
                }
            }
        });
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
            <div id="input-wrapper">
                <textarea id="prompt-input" placeholder="Ask anything..." rows="1"></textarea>
                <div id="action-row">
                    <select id="model-select" class="model-selector">
                        <option value="auto">Auto (Gemini 3)</option>
                    </select>
                    <button id="send-button">SEND</button>
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
