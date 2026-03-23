import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export class GeminiChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'geminiChatView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

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

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'sendPrompt':
                    {
                        this.askGemini(data.value, data.model);
                        break;
                    }
                case 'login':
                    {
                        this.handleLogin();
                        break;
                    }
                case 'getAuthState':
                    {
                        this.sendAuthState();
                        break;
                    }
            }
        });
    }

    private handleLogin() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: 'Opening a new terminal for secure interactive authentication. Please check the bottom panel!' });
        }
        
        // Spawn a native VS Code terminal
        const term = vscode.window.createTerminal("Gemini Auth");
        term.show();
        
        // Use the interactive prompt flag to immediately launch the auth menu in the TUI!
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
        } catch (err) {
            console.error('Error reading auth state:', err);
        }
        this._view.webview.postMessage({ type: 'authState', email: null });
    }

    private askGemini(prompt: string, model: string = "auto") {
        if (this._view) {
            this._view.webview.postMessage({ type: 'addMessage', role: 'user', content: prompt });
            this._view.webview.postMessage({ type: 'setLoading', value: true });
        }

        // We MUST use the -p or --prompt flag, otherwise the CLI enters interactive TUI mode and hangs forever waiting for user input!
        const args = ['-p', prompt];
        if (model && model !== 'auto') {
            args.push('-m');
            args.push(model);
        }

        const child = spawn('gemini', args, { shell: true });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.on('close', (code) => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', value: false });
                if (code !== 0) {
                    this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `Error (Exit Code ${code}):\n${errorOutput}` });
                } else {
                    this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: output });
                }
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const htmlPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'webview', 'index.html');
        const cssPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'webview', 'style.css');
        const jsPathOnDisk = vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js');

        const cssUri = webview.asWebviewUri(cssPathOnDisk);
        const jsUri = webview.asWebviewUri(jsPathOnDisk);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Chat</title>
    <link href="${cssUri}" rel="stylesheet">
</head>
<body>
    <div id="app-header">
        <span class="title">Gemini</span>
        <button id="toggle-settings-btn" title="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
    </div>

    <!-- Main Chat View -->
    <div id="chat-view" class="view">
        <div id="messages"></div>
        <div id="bottom-anchor">
            <div id="loading" class="hidden">
                 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
                 Gemini is thinking...
            </div>
            <div id="input-wrapper">
                <textarea id="prompt-input" placeholder="Ask anything, @ to mention, / for workflows" rows="1"></textarea>
                <div id="action-row">
                    <div class="action-left">
                        <div class="action-btn">
                            <span style="font-weight:bold; font-size:14px; margin-right:2px;">+</span>
                        </div>
                        <div class="action-btn">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                            Fast
                        </div>
                        <div class="action-btn">
                            <select id="model-select" class="model-selector">
                                <option value="auto">Auto (Gemini 3)</option>
                                <option value="gemini-3-pro-preview">gemini-3-pro-preview</option>
                                <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                                <option value="gemini-3.1-flash-lite-preview">gemini-3.1-flash-lite-preview</option>
                                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                                <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
                            </select>
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <div class="action-btn">
                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                        </div>
                        <button id="send-button">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Settings View -->
    <div id="settings-view" class="view hidden">
        <h2>Settings & Config</h2>
        <div class="setting-item">
            <div id="auth-info-text" class="auth-placeholder">Connect your Google Account to use the Gemini CLI natively through the workspace.</div>
            <button id="login-btn" class="primary-button">Log In</button>
        </div>
    </div>

    <script src="${jsUri}"></script>
</body>
</html>`;
    }
}
