import * as vscode from 'vscode';
import { GeminiChatViewProvider } from './GeminiChatViewProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new GeminiChatViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(GeminiChatViewProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gemini-chat.start', () => {
            vscode.commands.executeCommand('workbench.view.extension.gemini-chat-container');
        })
    );
}

export function deactivate() {}
